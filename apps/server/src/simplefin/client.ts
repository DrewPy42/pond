import { parseAccountSet } from './parse.js'
import { assertSafeUrl, decodeSetupToken, splitAccessUrl } from './url.js'
import { SimpleFinError, type FetchOptions, type SimpleFinClient } from './types.js'

const MAX_BYTES = 20 * 1024 * 1024
type FetchLike = typeof fetch

/** The real SimpleFIN client, using Node's built-in fetch (no extra dependency). */
export function createHttpSimpleFinClient(
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): SimpleFinClient {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 30_000

  async function request(
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; text: string }> {
    try {
      // Redirects are refused: they could send credentials somewhere we didn't vet.
      const res = await doFetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      if (text.length > MAX_BYTES)
        throw new SimpleFinError('bad_response', 'The response was too large.')
      return { status: res.status, text }
    } catch (e) {
      if (e instanceof SimpleFinError) throw e
      throw new SimpleFinError('network', 'Could not reach SimpleFIN.')
    }
  }

  return {
    async claim(setupToken) {
      const claimUrl = decodeSetupToken(setupToken)
      const { status, text } = await request(claimUrl, {
        method: 'POST',
      })
      if (status === 403) {
        throw new SimpleFinError(
          'token_rejected',
          'SimpleFIN rejected the token. It may be wrong or already used. If you did not use it yourself, disable it in your SimpleFIN account.',
        )
      }
      if (status !== 200)
        throw new SimpleFinError('http_error', `SimpleFIN answered with status ${status}.`)
      const accessUrl = text.trim()
      assertSafeUrl(accessUrl) // must be a public https URL
      splitAccessUrl(accessUrl) // must carry credentials
      return accessUrl
    },

    async fetchAccounts(accessUrl, o: FetchOptions) {
      const { base, authorization } = splitAccessUrl(accessUrl)
      const params = new URLSearchParams()
      if (o.startDate) params.set('start-date', String(Math.floor(o.startDate.getTime() / 1000)))
      if (o.pending) params.set('pending', '1')
      if (o.balancesOnly) params.set('balances-only', '1')
      const qs = params.toString()
      const { status, text } = await request(`${base}/accounts${qs ? `?${qs}` : ''}`, {
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/json' },
      })
      if (status === 402)
        throw new SimpleFinError(
          'payment_required',
          'SimpleFIN says payment is required for this account.',
        )
      if (status === 403)
        throw new SimpleFinError(
          'auth_failed',
          'SimpleFIN rejected our access. It may have been revoked; connect again.',
        )
      if (status !== 200)
        throw new SimpleFinError('http_error', `SimpleFIN answered with status ${status}.`)
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new SimpleFinError('bad_response', 'SimpleFIN returned something that is not JSON.')
      }
      return parseAccountSet(json)
    },
  }
}
