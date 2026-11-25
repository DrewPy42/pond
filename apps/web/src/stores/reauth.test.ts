import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../api'
import { useReauthStore } from './reauth'

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
}))

describe('the password re-check store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
  })

  /**
   * Function: request(), submit()
   * Inputs:   two callers ask at once; a wrong password, then the right one (fake server)
   * Expected: one shared dialog; it stays open with an error after the wrong password; both callers
   *           get true after the right one; only the password was sent, to /api/auth/reauth
   */
  it('shares one dialog and stays open until the password is accepted', async () => {
    const store = useReauthStore()
    const first = store.request()
    const second = store.request()
    expect(store.open).toBe(true)
    vi.mocked(api).mockRejectedValueOnce(new ApiError(401, 'invalid_credentials'))
    await store.submit('wrong')
    expect([store.open, store.error]).toEqual([true, "That password isn't right."])
    vi.mocked(api).mockResolvedValueOnce({})
    await store.submit('right')
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(store.open).toBe(false)
    expect(vi.mocked(api).mock.calls.at(-1)).toEqual([
      '/api/auth/reauth',
      { method: 'POST', body: { password: 'right' } },
    ])
  })

  /**
   * Function: cancel()
   * Inputs:   a request that the person cancels, then a new request
   * Expected: the first gets false; the next opens a fresh dialog
   */
  it('answers false on cancel and can be asked again', async () => {
    const store = useReauthStore()
    const first = store.request()
    store.cancel()
    expect(await first).toBe(false)
    expect(store.open).toBe(false)
    const next = store.request()
    expect(store.open).toBe(true)
    vi.mocked(api).mockResolvedValueOnce({})
    await store.submit('right')
    expect(await next).toBe(true)
  })
})
