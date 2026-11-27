import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VForm } from 'vuetify/components'
import { ApiError } from '../api'
import { mountWithVuetify } from '../testing/mountWithVuetify'
import LoginView from './LoginView.vue'

// The network and router are replaced: these tests check what the screen shows and sends.
const apiMock = vi.fn()
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  api: (...a: unknown[]) => apiMock(...a),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useRoute: () => ({ query: {} }),
}))

const needsCode = () => new ApiError(401, 'totp_required', {})
const refused = () => new ApiError(401, 'invalid_credentials', {})

/** The screen after a right username and password: the code box is showing. */
async function atCodeStep() {
  const wrapper = mountWithVuetify(LoginView)
  const input = (label: string) => {
    // Vuetify draws two labels per field; only one is tied to the input.
    const found = wrapper
      .findAll('label')
      .find((l) => l.text().startsWith(label) && l.attributes('for'))
    return found ? wrapper.find(`input#${found.attributes('for')}`) : null
  }
  const submit = async () => {
    await wrapper.findComponent(VForm).trigger('submit')
    await flushPromises()
  }
  await input('Username')!.setValue('ann')
  await input('Password')!.setValue('correct horse battery')
  apiMock.mockRejectedValueOnce(needsCode())
  await submit()
  return { wrapper, input, submit }
}

describe('<LoginView />', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    apiMock.mockReset()
  })

  /**
   * Inputs:   a right username and password for an account with two-step sign-in
   * Expected: the code box appears, and the username and password can still be changed
   */
  it('leaves the username and password editable when it asks for a code', async () => {
    const { input } = await atCodeStep()
    expect(input('Authenticator code')).not.toBeNull()
    expect(input('Username')!.attributes('disabled')).toBeUndefined()
    expect(input('Password')!.attributes('disabled')).toBeUndefined()
  })

  /**
   * Inputs:   the password is changed while the code box shows, then Sign in
   * Expected: the code box and typed code go away, and the next request sends the new password
   *           with no code, so it is checked from the start
   */
  it.each(['Username', 'Password'])('starts over when the %s is changed', async (field) => {
    const { wrapper, input, submit } = await atCodeStep()
    await input('Authenticator code')!.setValue('123456')
    await input(field)!.setValue('something else')
    expect(input('Authenticator code')).toBeNull()
    expect(wrapper.find('button[type="submit"]').text()).toBe('Sign in')
    apiMock.mockRejectedValueOnce(needsCode())
    await submit()
    expect(apiMock.mock.calls.at(-1)![1].body.code).toBeUndefined()
    expect((input('Authenticator code')!.element as HTMLInputElement).value).toBe('')
  })

  /**
   * Inputs:   a wrong authenticator code after the password was accepted
   * Expected: the message is about the code and doesn't blame the password; the code box stays,
   *           emptied for the next code
   */
  it('says it was the code that failed', async () => {
    const { wrapper, input, submit } = await atCodeStep()
    await input('Authenticator code')!.setValue('000000')
    apiMock.mockRejectedValueOnce(refused())
    await submit()
    expect(wrapper.text()).toContain("That code didn't work")
    expect(wrapper.text()).not.toContain('password or code')
    expect((input('Authenticator code')!.element as HTMLInputElement).value).toBe('')
  })

  /**
   * Inputs:   a refusal before any code was asked for
   * Expected: the message names the username and password only
   */
  it('names only the username and password at the first step', async () => {
    const wrapper = mountWithVuetify(LoginView)
    apiMock.mockRejectedValueOnce(refused())
    await wrapper.findComponent(VForm).trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('Wrong username or password.')
  })

  /**
   * Inputs:   the "Show password" button, pressed twice
   * Expected: the password can be read, then is hidden again
   */
  it('can show the password so it can be checked', async () => {
    const { wrapper, input } = await atCodeStep()
    expect(input('Password')!.attributes('type')).toBe('password')
    await wrapper.find('[aria-label="Show password"]').trigger('click')
    expect(input('Password')!.attributes('type')).toBe('text')
    await wrapper.find('[aria-label="Hide password"]').trigger('click')
    expect(input('Password')!.attributes('type')).toBe('password')
  })
})
