import { describe, expect, it, vi } from 'vitest'
import { filenameFrom, roleAllows, withReauth } from './padFiles'

describe('roleAllows', () => {
  /**
   * Function: roleAllows
   * Inputs:   items with no role, "owner" and "editor", seen by viewers, editors, owners and nobody
   * Expected: no role shows to everyone; otherwise only that role or higher
   */
  it('shows items to that role and above', () => {
    expect(roleAllows(undefined, undefined)).toBe(true)
    expect(roleAllows('owner', 'editor')).toBe(false)
    expect(roleAllows('owner', 'owner')).toBe(true)
    expect(roleAllows('editor', 'viewer')).toBe(false)
    expect(roleAllows('editor', 'owner')).toBe(true)
    expect(roleAllows('viewer', undefined)).toBe(false)
  })
})

describe('filenameFrom', () => {
  /**
   * Function: filenameFrom
   * Inputs:   a header with both forms, one with only the plain form, a broken encoded form, and none
   * Expected: the encoded name wins; then the plain one; otherwise "download"
   */
  it('reads the name from a Content-Disposition header', () => {
    expect(filenameFrom(`attachment; filename="re_u.pdf"; filename*=UTF-8''re%C3%A7u.pdf`)).toBe(
      'reçu.pdf',
    )
    expect(filenameFrom('attachment; filename="a b.pdf"')).toBe('a b.pdf')
    expect(filenameFrom(`attachment; filename="x.pdf"; filename*=UTF-8''%E0%A4%A`)).toBe('x.pdf')
    expect(filenameFrom(null)).toBe('download')
  })
})

describe('withReauth', () => {
  const refusal = { code: 'reauth_required' }

  /**
   * Function: withReauth
   * Inputs:   a request refused once with reauth_required; the person enters their password
   * Expected: asked once, retried once, and the retry's result is returned
   */
  it('asks for the password and retries once', async () => {
    const request = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValue('ok')
    const ask = vi.fn().mockResolvedValue(true)
    await expect(withReauth(request, ask)).resolves.toBe('ok')
    expect([request.mock.calls.length, ask.mock.calls.length]).toEqual([2, 1])
  })

  /**
   * Function: withReauth
   * Inputs:   the person cancels; a different error; a server that keeps refusing after the password
   * Expected: the error is passed on; no retry on cancel or other errors; never more than one retry
   */
  it('gives up on cancel, ignores other errors, and never loops', async () => {
    const cancelled = vi.fn().mockRejectedValue(refusal)
    await expect(withReauth(cancelled, async () => false)).rejects.toBe(refusal)
    expect(cancelled).toHaveBeenCalledTimes(1)

    const other = { code: 'forbidden' }
    const ask = vi.fn()
    await expect(withReauth(vi.fn().mockRejectedValue(other), ask)).rejects.toBe(other)
    expect(ask).not.toHaveBeenCalled()

    const stubborn = vi.fn().mockRejectedValue(refusal)
    await expect(withReauth(stubborn, async () => true)).rejects.toBe(refusal)
    expect(stubborn).toHaveBeenCalledTimes(2)
  })
})
