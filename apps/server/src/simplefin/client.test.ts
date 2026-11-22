import { describe, expect, it } from 'vitest'
import { createHttpSimpleFinClient } from './client'
import { SimpleFinError } from './types'

/** A fake `fetch` that records requests and answers with scripted responses. No network. */
function fakeFetch(responses: { status: number; body: string }[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = responses.shift() ?? { status: 500, body: '' }
    return new Response(r.body, { status: r.status })
  }) as typeof fetch
  return { fetchImpl, calls }
}
const token = Buffer.from('https://bridge.simplefin.org/simplefin/claim/abc').toString('base64')
const ACCESS = 'https://user:pw@bridge.simplefin.org/simplefin'
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e instanceof SimpleFinError ? e.code : 'other'
  }
  return 'no error'
}

describe('SimpleFIN HTTP client: claim(setupToken)', () => {
  /**
   * Inputs:   a valid token; the server answers 200 with an Access URL
   * Expected: POSTs once to the decoded claim URL with redirects refused, and returns the URL
   */
  it('exchanges a token for an Access URL', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: `${ACCESS}\n` }])
    const url = await createHttpSimpleFinClient({ fetchImpl }).claim(token)
    expect(url).toBe(ACCESS)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://bridge.simplefin.org/simplefin/claim/abc')
    expect(calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'error' })
  })
  /**
   * Inputs:   the server answers 403; then 500; then 200 with an Access URL that points at 10.0.0.5
   * Expected: "token_rejected"; "http_error"; "unsafe_url" (an unsafe URL is never stored)
   */
  it('maps failures to clear errors', async () => {
    const c = (status: number, body = '') =>
      createHttpSimpleFinClient({ fetchImpl: fakeFetch([{ status, body }]).fetchImpl }).claim(token)
    expect(await codeOf(c(403))).toBe('token_rejected')
    expect(await codeOf(c(500))).toBe('http_error')
    expect(await codeOf(c(200, 'https://u:p@10.0.0.5/simplefin'))).toBe('unsafe_url')
  })
  /**
   * Inputs:   a token whose claim URL is http://localhost/claim; and fetch throwing a network error
   * Expected: "unsafe_url" without making any request; "network"
   */
  it('refuses unsafe claim URLs before any request, and reports network failures', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const local = Buffer.from('http://localhost/claim/x').toString('base64')
    expect(await codeOf(createHttpSimpleFinClient({ fetchImpl }).claim(local))).toBe('unsafe_url')
    expect(calls).toHaveLength(0)
    const boom = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await codeOf(createHttpSimpleFinClient({ fetchImpl: boom }).claim(token))).toBe(
      'network',
    )
  })
})

describe('SimpleFIN HTTP client: fetchAccounts(accessUrl, options)', () => {
  const okBody = JSON.stringify({
    errlist: [],
    accounts: [{ id: 'A', name: 'X', currency: 'USD', balance: '1.00', 'balance-date': 1 }],
  })

  /**
   * Inputs:   startDate = epoch 1893844800 s, pending = true, balancesOnly = true
   * Expected: GET {base}/accounts?start-date=1893844800&pending=1&balances-only=1 with a Basic
   *           Authorization header; the credentials are NOT in the URL; the result is parsed
   */
  it('builds the request with query options and header auth', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: okBody }])
    const r = await createHttpSimpleFinClient({ fetchImpl }).fetchAccounts(ACCESS, {
      startDate: new Date(1893844800 * 1000),
      pending: true,
      balancesOnly: true,
    })
    expect(r.accounts[0]!.balanceCents).toBe(100)
    const { url, init } = calls[0]!
    expect(url).toBe(
      'https://bridge.simplefin.org/simplefin/accounts?start-date=1893844800&pending=1&balances-only=1',
    )
    expect(url).not.toContain('pw')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('user:pw').toString('base64')}`,
    )
  })
  /**
   * Inputs:   no options
   * Expected: GET {base}/accounts with no query string
   */
  it('sends no query string when there are no options', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: okBody }])
    await createHttpSimpleFinClient({ fetchImpl }).fetchAccounts(ACCESS, {})
    expect(calls[0]!.url).toBe('https://bridge.simplefin.org/simplefin/accounts')
  })
  /**
   * Inputs:   responses 402, 403, 500, and a 200 that isn't JSON
   * Expected: "payment_required", "auth_failed", "http_error", "bad_response"
   */
  it('maps status codes and bad bodies to clear errors', async () => {
    const f = (status: number, body = '') =>
      createHttpSimpleFinClient({
        fetchImpl: fakeFetch([{ status, body }]).fetchImpl,
      }).fetchAccounts(ACCESS, {})
    expect(await codeOf(f(402))).toBe('payment_required')
    expect(await codeOf(f(403))).toBe('auth_failed')
    expect(await codeOf(f(500))).toBe('http_error')
    expect(await codeOf(f(200, '<html>'))).toBe('bad_response')
  })
})
