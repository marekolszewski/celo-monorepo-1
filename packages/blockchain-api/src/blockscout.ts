import { RESTDataSource } from 'apollo-datasource-rest'
import BigNumber from 'bignumber.js'
import { BLOCKSCOUT_API, FAUCET_ADDRESS, VERIFICATION_REWARDS_ADDRESS } from './config'
import {
  EventArgs,
  EventInterface,
  EventTypes,
  TokenTransactionArgs,
  TransferEvent,
} from './schema'
import { formatCommentString, getContractAddresses } from './utils'

// to get rid of 18 extra 0s in the values
const WEI_PER_GOLD = Math.pow(10, 18)

const MODULES = {
  // See https://blockscout.com/eth/mainnet/api_docs for API endpoints + param list
  ACCOUNT: 'account',
}

const MODULE_ACTIONS = {
  ACCOUNT: {
    BALANCE: 'balance',
    BALANCE_MULTI: 'balancemulti',
    TX_LIST: 'txlist',
    TX_LIST_INTERNAL: 'txlistinternal',
    TOKEN_TX: 'tokentx',
    TOKEN_BALANCE: 'tokenbalance',
  },
}

export interface BlockscoutTransaction {
  value: string
  txreceipt_status: string
  transactionIndex: string
  tokenSymbol: string
  tokenName: string
  tokenDecimal: string
  to: string
  timeStamp: string
  nonce: string
  isError: string
  input: string
  hash: string
  gasUsed: string
  gasPrice: string
  gas: string
  from: string
  cumulativeGasUsed: string
  contractAddress: string
  confirmations: string
  blockNumber: string
  blockHash: string
}

export class BlockscoutAPI extends RESTDataSource {
  tokenAddressMapping: { [key: string]: string } | undefined
  attestationsAddress: string | undefined
  escrowAddress: string | undefined
  goldTokenAddress: string | undefined
  stableTokenAddress: string | undefined
  constructor() {
    super()
    this.baseURL = BLOCKSCOUT_API
  }

  async getRawTokenTransactions(args: EventArgs): Promise<BlockscoutTransaction[]> {
    console.info('Getting token transactions', args)
    const params = {
      ...args,
      module: MODULES.ACCOUNT,
      action: MODULE_ACTIONS.ACCOUNT.TOKEN_TX,
    }
    const { result } = await this.get('', params)
    return result
  }

  async ensureTokenAddresses() {
    if (
      this.tokenAddressMapping &&
      this.attestationsAddress &&
      this.escrowAddress &&
      this.goldTokenAddress &&
      this.stableTokenAddress
    ) {
      // Already got addresses
      return
    } else {
      const addresses = await getContractAddresses()
      this.attestationsAddress = addresses.attestationsAddress
      this.tokenAddressMapping = addresses.tokenAddressMapping
      this.escrowAddress = addresses.escrowAddress
      this.goldTokenAddress = addresses.goldTokenAddress
      this.stableTokenAddress = addresses.stableTokenAddress
    }
  }

  getTokenAtAddress(tokenAddress: string) {
    if (this.tokenAddressMapping) {
      const lowerCaseTokenAddress = tokenAddress.toLowerCase()
      if (lowerCaseTokenAddress in this.tokenAddressMapping) {
        return this.tokenAddressMapping[lowerCaseTokenAddress]
      } else {
        console.info('Token addresses mapping: ' + JSON.stringify(this.tokenAddressMapping))
        throw new Error(
          'No token corresponding to ' +
            lowerCaseTokenAddress +
            '. Check web3 provider is for correct network.'
        )
      }
    } else {
      throw new Error('Cannot find tokenAddressMapping')
    }
  }

  getAttestationAddress() {
    if (this.attestationsAddress) {
      return this.attestationsAddress
    } else {
      throw new Error('Cannot find attestation address')
    }
  }

  getEscrowAddress() {
    if (this.escrowAddress) {
      return this.escrowAddress
    } else {
      throw new Error('Cannot find escrow address')
    }
  }

  // TODO(jeanregisser): this is now deprecated, remove once client changes have been merged
  // LIMITATION:
  // This function will only return Gold transfers that happened via the GoldToken
  // contract. Any native transfers of Gold will be omitted because of how blockscout
  // works. To get native transactions from blockscout, we'd need to use the param:
  // "action: MODULE_ACTIONS.ACCOUNT.TX_LIST"
  // However, the results returned from that API call do not have an easily-parseable
  // representation of Token transfers, if they are included at all. Given that we
  // expect native transfers to be exceedingly rare, the work to handle this is being
  // skipped for now. TODO: (yerdua) [226]
  async getFeedEvents(args: EventArgs) {
    const rawTransactions = await this.getRawTokenTransactions(args)
    const events: EventInterface[] = []
    const userAddress = args.address.toLowerCase()

    // Mapping to figure out what event each raw transaction belongs to
    const txHashToEventTransactions = new Map<string, any>()

    for (const tx of rawTransactions) {
      const currentTX = txHashToEventTransactions.get(tx.hash) || []
      currentTX.push(tx)
      txHashToEventTransactions.set(tx.hash, currentTX)
    }

    await this.ensureTokenAddresses()
    // Generate final events
    txHashToEventTransactions.forEach((transactions: BlockscoutTransaction[], txhash: string) => {
      // Exchange events have two corresponding transactions (in and out)
      if (transactions.length === 2) {
        let inEvent: BlockscoutTransaction, outEvent: BlockscoutTransaction
        if (transactions[0].from.toLowerCase() === userAddress) {
          inEvent = transactions[0]
          outEvent = transactions[1]
        } else {
          inEvent = transactions[1]
          outEvent = transactions[0]
        }

        events.push({
          type: EventTypes.EXCHANGE,
          timestamp: new BigNumber(inEvent.timeStamp).toNumber(),
          block: new BigNumber(inEvent.blockNumber).toNumber(),
          inSymbol: this.getTokenAtAddress(inEvent.contractAddress),
          inValue: new BigNumber(inEvent.value).dividedBy(WEI_PER_GOLD).toNumber(),
          outSymbol: this.getTokenAtAddress(outEvent.contractAddress),
          outValue: new BigNumber(outEvent.value).dividedBy(WEI_PER_GOLD).toNumber(),
          hash: txhash,
        })

        // Otherwise, it's a regular token transfer
      } else {
        const event = transactions[0]
        const comment = event.input ? formatCommentString(event.input) : ''
        const eventToAddress = event.to.toLowerCase()
        const eventFromAddress = event.from.toLowerCase()
        const [type, address] = resolveTransferEventType(
          userAddress,
          eventToAddress,
          eventFromAddress,
          this.getAttestationAddress(),
          this.getEscrowAddress()
        )
        events.push({
          type,
          timestamp: new BigNumber(event.timeStamp).toNumber(),
          block: new BigNumber(event.blockNumber).toNumber(),
          value: new BigNumber(event.value).dividedBy(WEI_PER_GOLD).toNumber(),
          address,
          comment,
          symbol: this.getTokenAtAddress(event.contractAddress) || 'unknown',
          hash: txhash,
        })
      }
    })

    console.info(
      `[Celo] getFeedEvents address=${args.address} startblock=${args.startblock} endblock=${args.endblock} rawTransactionCount=${rawTransactions.length} eventCount=${events.length}`
    )
    return events.sort((a, b) => b.timestamp - a.timestamp)
  }

  async getFeedRewards(args: EventArgs) {
    const rewards: TransferEvent[] = []
    const rawTransactions = await this.getRawTokenTransactions(args)
    await this.ensureTokenAddresses()
    for (const t of rawTransactions) {
      // Only include verification rewards transfers
      if (t.from.toLowerCase() !== VERIFICATION_REWARDS_ADDRESS) {
        continue
      }
      rewards.push({
        type: EventTypes.VERIFICATION_REWARD,
        timestamp: new BigNumber(t.timeStamp).toNumber(),
        block: new BigNumber(t.blockNumber).toNumber(),
        value: new BigNumber(t.value).dividedBy(WEI_PER_GOLD).toNumber(),
        address: VERIFICATION_REWARDS_ADDRESS,
        comment: t.input ? formatCommentString(t.input) : '',
        symbol: this.getTokenAtAddress(t.contractAddress),
        hash: t.hash,
      })
    }
    console.info(
      `[Celo] getFeedRewards address=${args.address} startblock=${args.startblock} endblock=${args.endblock} rawTransactionCount=${rawTransactions.length} rewardsCount=${rewards.length}`
    )
    return rewards.sort((a, b) => b.timestamp - a.timestamp)
  }

  // LIMITATION:
  // This function will only return Gold transfers that happened via the GoldToken
  // contract. Any native transfers of Gold will be omitted because of how blockscout
  // works. To get native transactions from blockscout, we'd need to use the param:
  // "action: MODULE_ACTIONS.ACCOUNT.TX_LIST"
  // However, the results returned from that API call do not have an easily-parseable
  // representation of Token transfers, if they are included at all. Given that we
  // expect native transfers to be exceedingly rare, the work to handle this is being
  // skipped for now. TODO: (yerdua) [226]
  async getTokenTransactions(args: TokenTransactionArgs) {
    const rawTransactions = await this.getRawTokenTransactions(args)
    const events: any[] = []
    const userAddress = args.address.toLowerCase()

    // Mapping to figure out what event each raw transaction belongs to
    const txHashToEventTransactions = new Map<string, any>()
    for (const tx of rawTransactions) {
      const currentTX = txHashToEventTransactions.get(tx.hash) || []
      currentTX.push(tx)
      txHashToEventTransactions.set(tx.hash, currentTX)
    }

    await this.ensureTokenAddresses()
    // Generate final events
    txHashToEventTransactions.forEach((transactions: BlockscoutTransaction[], txhash: string) => {
      // Exchange events have two corresponding transactions (in and out)
      if (transactions.length === 2) {
        let inEvent: BlockscoutTransaction, outEvent: BlockscoutTransaction
        if (transactions[0].from.toLowerCase() === userAddress) {
          inEvent = transactions[0]
          outEvent = transactions[1]
        } else {
          inEvent = transactions[1]
          outEvent = transactions[0]
        }

        // Find the event related to the queried token
        const tokenEvent = [inEvent, outEvent].find((event) => event.tokenSymbol === args.token)
        if (tokenEvent) {
          const timestamp = new BigNumber(inEvent.timeStamp).toNumber() * 1000
          events.push({
            type: EventTypes.EXCHANGE,
            timestamp,
            block: inEvent.blockNumber,
            amount: {
              // Signed amount relative to the account currency
              value: new BigNumber(tokenEvent.value)
                .multipliedBy(tokenEvent === inEvent ? -1 : 1)
                .dividedBy(WEI_PER_GOLD)
                .toString(),
              currencyCode: tokenEvent.tokenSymbol,
              timestamp,
            },
            makerAmount: {
              value: new BigNumber(inEvent.value).dividedBy(WEI_PER_GOLD).toString(),
              currencyCode: inEvent.tokenSymbol,
              timestamp,
            },
            takerAmount: {
              value: new BigNumber(outEvent.value).dividedBy(WEI_PER_GOLD).toString(),
              currencyCode: outEvent.tokenSymbol,
              timestamp,
            },
            hash: txhash,
          })
        }

        // Otherwise, it's a regular token transfer
      } else {
        const stableTokenTxs = transactions.filter(
          (tx) => tx.contractAddress.toLowerCase() === this.stableTokenAddress && tx.value !== '0'
        )

        stableTokenTxs.sort((a, b) =>
          new BigNumber(b.value).minus(new BigNumber(a.value)).toNumber()
        )

        if (stableTokenTxs.length < 1) {
          return
        }
        const gasValue = new BigNumber(stableTokenTxs[0].gasUsed).multipliedBy(
          new BigNumber(stableTokenTxs[0].gasPrice)
        )
        let event

        switch (stableTokenTxs.length) {
          // simple transfer
          case 1:
            event = stableTokenTxs[0]
            break

          // transfer with feeCurrency
          // this figures out which 2 tx are the fee, and the other is the transfer
          case 3:
            const tx0Value = new BigNumber(stableTokenTxs[0].value)
            const tx1Value = new BigNumber(stableTokenTxs[1].value)
            const tx2Value = new BigNumber(stableTokenTxs[2].value)

            if (tx0Value.plus(tx1Value).isEqualTo(gasValue)) {
              event = stableTokenTxs[2]
            } else if (tx0Value.plus(tx2Value).isEqualTo(gasValue)) {
              event = stableTokenTxs[1]
            } else {
              event = stableTokenTxs[0]
            }
            break

          // just a contract call
          default:
            return
        }

        const comment = event.input ? formatCommentString(event.input) : ''
        const eventToAddress = event.to.toLowerCase()
        const eventFromAddress = event.from.toLowerCase()
        const [type, address] = resolveTransferEventType(
          userAddress,
          eventToAddress,
          eventFromAddress,
          this.getAttestationAddress(),
          this.getEscrowAddress()
        )
        const timestamp = new BigNumber(event.timeStamp).toNumber() * 1000
        events.push({
          type,
          timestamp,
          block: event.blockNumber,
          amount: {
            // Signed amount relative to the account currency
            value: new BigNumber(event.value)
              .multipliedBy(eventFromAddress === userAddress ? -1 : 1)
              .dividedBy(WEI_PER_GOLD)
              .toString(),
            currencyCode: event.tokenSymbol,
            timestamp,
          },
          address,
          comment,
          hash: txhash,
        })
      }
    })

    console.info(
      `[Celo] getTokenTransactions address=${args.address} token=${args.token} localCurrencyCode=${args.localCurrencyCode}
      } rawTransactionCount=${rawTransactions.length} eventCount=${events.length}`
    )
    return events
      .filter((event) => event.amount.currencyCode === args.token)
      .sort((a, b) => b.timestamp - a.timestamp)
  }
}

function resolveTransferEventType(
  userAddress: string,
  eventToAddress: string,
  eventFromAddress: string,
  attestationsAddress: string,
  escrowAddress: string
): [EventTypes, string] {
  if (eventToAddress === userAddress && eventFromAddress === FAUCET_ADDRESS) {
    return [EventTypes.FAUCET, FAUCET_ADDRESS]
  }
  if (eventToAddress === attestationsAddress && eventFromAddress === userAddress) {
    return [EventTypes.VERIFICATION_FEE, attestationsAddress]
  }
  if (eventToAddress === userAddress && eventFromAddress === VERIFICATION_REWARDS_ADDRESS) {
    return [EventTypes.VERIFICATION_REWARD, VERIFICATION_REWARDS_ADDRESS]
  }
  if (eventToAddress === userAddress && eventFromAddress === escrowAddress) {
    return [EventTypes.ESCROW_RECEIVED, eventFromAddress]
  }
  if (eventToAddress === userAddress) {
    return [EventTypes.RECEIVED, eventFromAddress]
  }
  if (eventFromAddress === userAddress && eventToAddress === escrowAddress) {
    return [EventTypes.ESCROW_SENT, eventToAddress]
  }
  if (eventFromAddress === userAddress) {
    return [EventTypes.SENT, eventToAddress]
  }
  throw new Error('No valid event type found ')
}
