import * as React from 'react'
import 'react-native'
import { fireEvent, render } from 'react-native-testing-library'
import { Provider } from 'react-redux'
import * as renderer from 'react-test-renderer'
import { ErrorMessages } from 'src/app/ErrorMessages'
import JoinCelo, { JoinCelo as JoinCeloClass } from 'src/invite/JoinCelo'
import { createMockStore, getMockI18nProps } from 'test/utils'

describe('JoinCeloScreen', () => {
  it('renders correctly', () => {
    const store = createMockStore()
    const tree = renderer.create(
      <Provider store={store}>
        <JoinCelo {...getMockI18nProps()} />
      </Provider>
    )
    expect(tree).toMatchSnapshot()
  })

  it('renders with an error', () => {
    const store = createMockStore({ alert: { underlyingError: ErrorMessages.INVALID_INVITATION } })
    const tree = renderer.create(
      <Provider store={store}>
        <JoinCelo />
      </Provider>
    )
    expect(tree).toMatchSnapshot()
  })

  it('is disabled with no text', () => {
    const wrapper = render(
      <Provider store={createMockStore()}>
        <JoinCeloClass
          showError={jest.fn()}
          hideAlert={jest.fn()}
          setPhoneNumber={jest.fn()}
          setName={jest.fn()}
          error={null}
          language={'en-us'}
          cachedName={''}
          cachedNumber={''}
          cachedCountryCode={''}
          pincodeSet={false}
          redeemComplete={jest.fn()}
          {...getMockI18nProps()}
        />
      </Provider>
    )
    expect(wrapper.queryAllByProps({ disabled: true }).length).toBeGreaterThan(0)
  })

  it('continue button disabled when invalid number', () => {
    const error = jest.fn()

    const wrapper = render(
      <Provider store={createMockStore()}>
        <JoinCeloClass
          showError={error}
          hideAlert={jest.fn()}
          setPhoneNumber={jest.fn()}
          setName={jest.fn()}
          error={null}
          language={'en-us'}
          cachedName={''}
          cachedNumber={''}
          cachedCountryCode={''}
          pincodeSet={false}
          redeemComplete={jest.fn()}
          {...getMockI18nProps()}
        />
      </Provider>
    )
    fireEvent.changeText(wrapper.getByTestId('PhoneNumberField'), '12345')
    expect(wrapper.queryAllByProps({ disabled: true }).length).toBeGreaterThan(0)
  })

  it('calls account actions when input different from cached', () => {
    const setName = jest.fn()
    const setPhoneNumber = jest.fn()

    const wrapper = render(
      <Provider store={createMockStore()}>
        <JoinCeloClass
          showError={jest.fn()}
          hideAlert={jest.fn()}
          setPhoneNumber={setPhoneNumber}
          setName={setName}
          error={null}
          language={'en-us'}
          cachedName={'Bob Doe'}
          cachedNumber={'+14151234567'}
          cachedCountryCode={'+1'}
          pincodeSet={false}
          redeemComplete={jest.fn()}
          {...getMockI18nProps()}
        />
      </Provider>
    )
    fireEvent.changeText(wrapper.getByTestId('NameEntry'), 'John Doe')
    fireEvent.changeText(wrapper.getByTestId('PhoneNumberField'), '+14155556666')
    fireEvent.press(wrapper.getByTestId('JoinCeloContinueButton'))
    expect(setName).toHaveBeenCalledWith('John Doe')
    expect(setPhoneNumber).toHaveBeenCalledWith('+14155556666', '+1')
  })

  it('does not calls account actions when input same as cached', () => {
    const setName = jest.fn()
    const setPhoneNumber = jest.fn()

    const wrapper = render(
      <Provider store={createMockStore()}>
        <JoinCeloClass
          showError={jest.fn()}
          hideAlert={jest.fn()}
          setPhoneNumber={setPhoneNumber}
          setName={setName}
          error={null}
          language={'en-us'}
          cachedName={'John Doe'}
          cachedNumber={'+14155556666'}
          cachedCountryCode={'+1'}
          pincodeSet={false}
          redeemComplete={jest.fn()}
          {...getMockI18nProps()}
        />
      </Provider>
    )
    fireEvent.changeText(wrapper.getByTestId('NameEntry'), 'John Doe')
    fireEvent.changeText(wrapper.getByTestId('PhoneNumberField'), '+14155556666')
    fireEvent.press(wrapper.getByTestId('JoinCeloContinueButton'))
    expect(setName).not.toHaveBeenCalledWith('John Doe')
    expect(setPhoneNumber).not.toHaveBeenCalledWith('+14151234567', '+1')
  })
})
