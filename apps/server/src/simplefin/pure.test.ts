import { describe, expect, it } from 'vitest'
import { decimalStringToCents } from './amounts'
import { parseAccountSet, sanitizeMessage } from './parse'
import { SimpleFinError } from './types'
import { assertSafeUrl, decodeSetupToken, splitAccessUrl } from './url'

const b64 = (s: string) => Buffer.from(s).toString('base64')
const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof SimpleFinError ? e.code : 'other'
  }
  return 'no error'
}

describe('decimalStringToCents(input)', () => {
  /**
   * Inputs:   "12.34", "-12.3", "7", "+0.05", "1000000.00", "-0.01"
   * Expected: 1234, -1230, 700, 5, 100000000, -1 (exact, no floating point)
   */
  it('converts decimal strings to integer cents', () => {
    expect(decimalStringToCents('12.34')).toBe(1234)
    expect(decimalStringToCents('-12.3')).toBe(-1230)
    expect(decimalStringToCents('7')).toBe(700)
    expect(decimalStringToCents('+0.05')).toBe(5)
    expect(decimalStringToCents('1000000.00')).toBe(100000000)
    expect(decimalStringToCents('-0.01')).toBe(-1)
  })
  /**
   * Inputs:   "12.3400" and "5.000" (extra zeros)
   * Expected: 1234 and 500 (trailing zeros beyond cents are harmless)
   */
  it('allows extra decimal places that are zeros', () => {
    expect(decimalStringToCents('12.3400')).toBe(1234)
    expect(decimalStringToCents('5.000')).toBe(500)
  })
  /**
   * Inputs:   "1.234" (a fraction of a cent), "abc", "", "1,000.00", "1e5"
   * Expected: each throws a SimpleFinError "bad_response" (never rounded or guessed)
   */
  it('refuses fractions of a cent and non-numbers', () => {
    for (const bad of ['1.234', 'abc', '', '1,000.00', '1e5'])
      expect(
        code(() => decimalStringToCents(bad)),
        bad,
      ).toBe('bad_response')
  })
})

describe('decodeSetupToken(token) and assertSafeUrl(url)', () => {
  /**
   * Inputs:   the Base64 of "https://bridge.simplefin.org/simplefin/claim/abc123"
   * Expected: the claim URL back, unchanged
   */
  it('decodes a Setup Token into its claim URL', () => {
    expect(decodeSetupToken(b64('https://bridge.simplefin.org/simplefin/claim/abc123'))).toBe(
      'https://bridge.simplefin.org/simplefin/claim/abc123',
    )
  })
  /**
   * Inputs:   the token with surrounding spaces and a line break inside; and text that is not Base64
   * Expected: whitespace is tolerated; non-Base64 gives "invalid_token"
   */
  it('tolerates pasted whitespace but rejects junk', () => {
    const t = b64('https://bridge.simplefin.org/claim/x')
    expect(decodeSetupToken(`  ${t.slice(0, 10)}\n${t.slice(10)}  `)).toBe(
      'https://bridge.simplefin.org/claim/x',
    )
    expect(code(() => decodeSetupToken('not a token!'))).toBe('invalid_token')
    expect(code(() => decodeSetupToken(b64('just some words')))).toBe('invalid_token')
  })
  /**
   * Inputs:   http://, localhost, 127.0.0.1, 10.0.0.5, 192.168.1.1, 172.16.0.1, 169.254.1.1,
   *           [::1], a bare hostname, a custom port, printer.local
   * Expected: each refused with "unsafe_url" (Pond must not be pointed at the home network)
   */
  it('refuses non-https and private or local addresses', () => {
    for (const bad of [
      'http://bridge.simplefin.org/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://192.168.1.1/x',
      'https://172.16.0.1/x',
      'https://169.254.1.1/x',
      'https://[::1]/x',
      'https://intranet/x',
      'https://bridge.simplefin.org:8443/x',
      'https://printer.local/x',
    ]) {
      expect(
        code(() => assertSafeUrl(bad)),
        bad,
      ).toBe('unsafe_url')
    }
  })
  /**
   * Inputs:   https://bridge.simplefin.org/simplefin and a public IP on 172.32.x (outside 172.16/12)
   * Expected: accepted
   */
  it('accepts public https addresses', () => {
    expect(() => assertSafeUrl('https://bridge.simplefin.org/simplefin')).not.toThrow()
    expect(() => assertSafeUrl('https://172.32.0.1/x')).not.toThrow()
  })
})

describe('splitAccessUrl(accessUrl)', () => {
  /**
   * Inputs:   https://us%40er:p%3Ass@bridge.simplefin.org/simplefin
   * Expected: base has no credentials; the Authorization header is Basic of "us@er:p:ss"
   *           (percent-encoding decoded)
   */
  it('moves the credentials from the URL into a Basic auth header', () => {
    const r = splitAccessUrl('https://us%40er:p%3Ass@bridge.simplefin.org/simplefin')
    expect(r.base).toBe('https://bridge.simplefin.org/simplefin')
    expect(r.authorization).toBe(`Basic ${Buffer.from('us@er:p:ss').toString('base64')}`)
  })
  /**
   * Inputs:   an Access URL without credentials
   * Expected: "bad_response"
   */
  it('requires credentials', () => {
    expect(code(() => splitAccessUrl('https://bridge.simplefin.org/simplefin'))).toBe(
      'bad_response',
    )
  })
})

describe('sanitizeMessage(text)', () => {
  /**
   * Inputs:   text with a newline, a NUL and a bell character, and a 1000-character string
   * Expected: control characters become spaces and the result is cut to 300 characters
   */
  it('strips control characters and caps the length', () => {
    expect(sanitizeMessage('a\nb\u0000c\u0007d')).toBe('a b c d')
    expect(sanitizeMessage('x'.repeat(1000))).toHaveLength(300)
  })
})

describe('parseAccountSet(json)', () => {
  const v2 = {
    errlist: [{ code: 'con.auth', msg: 'Please re-authenticate\nnow', conn_id: 'c1' }],
    connections: [{ conn_id: 'c1', name: 'Test Bank', org_id: 'o', sfin_url: 'u' }],
    accounts: [
      {
        id: 'A1',
        name: 'Everyday Checking',
        conn_id: 'c1',
        currency: 'USD',
        balance: '1234.56',
        'available-balance': '1000.00',
        'balance-date': 1893844800,
        transactions: [
          { id: 'T1', posted: 1893844800, amount: '-12.34', description: 'COFFEE' },
          {
            id: 'T2',
            posted: 0,
            amount: '50.00',
            description: 'DEPOSIT',
            pending: true,
            transacted_at: 1893800000,
          },
        ],
      },
    ],
  }

  /**
   * Inputs:   a version-2 response with errlist, connections, one account and two transactions
   * Expected: balances and amounts as cents; the connection name becomes orgName; pending and
   *           transacted_at read; the error message is sanitized
   */
  it('reads a v2 account set into cents', () => {
    const r = parseAccountSet(v2)
    expect(r.messages).toEqual([
      { code: 'con.auth', msg: 'Please re-authenticate now', connId: 'c1', accountId: null },
    ])
    const a = r.accounts[0]!
    expect(a).toMatchObject({
      id: 'A1',
      balanceCents: 123456,
      availableCents: 100000,
      currency: 'USD',
      orgName: 'Test Bank',
      problems: [],
    })
    expect(a.transactions[0]).toMatchObject({ id: 'T1', amountCents: -1234, pending: false })
    expect(a.transactions[1]).toMatchObject({
      id: 'T2',
      amountCents: 5000,
      pending: true,
      postedEpoch: 0,
      transactedEpoch: 1893800000,
    })
  })
  /**
   * Inputs:   a version-1 response: "errors" as strings, "org" instead of connections, numeric
   *           amounts and epochs sent as strings
   * Expected: still parsed (messages from the strings, org name used, numbers coerced)
   */
  it('also reads the older v1 shape', () => {
    const r = parseAccountSet({
      errors: ['Something happened'],
      accounts: [
        {
          id: 'A',
          name: 'Savings',
          currency: 'USD',
          balance: 25.5,
          'balance-date': '1893844800',
          org: { name: 'Old Bank' },
          transactions: [{ id: 'X', posted: '1893844800', amount: -1, description: 'x' }],
        },
      ],
    })
    expect(r.messages[0]).toMatchObject({ code: 'gen', msg: 'Something happened' })
    expect(r.accounts[0]).toMatchObject({ balanceCents: 2550, orgName: 'Old Bank' })
    expect(r.accounts[0]!.transactions[0]).toMatchObject({
      amountCents: -100,
      postedEpoch: 1893844800,
    })
  })
  /**
   * Inputs:   an account with one good and one bad transaction (amount "1.234"), a custom-currency
   *           account (a URL), and an unreadable account entry
   * Expected: the bad transaction is dropped and listed in the account's problems; the URL
   *           currency becomes null; the unreadable entry becomes a message; nothing throws
   */
  it('records problems instead of guessing', () => {
    const r = parseAccountSet({
      errlist: [],
      accounts: [
        {
          id: 'A',
          name: 'Odd',
          currency: 'USD',
          balance: '1.00',
          'balance-date': 1,
          transactions: [
            { id: 'g', posted: 1, amount: '1.00', description: 'ok' },
            { id: 'b', posted: 1, amount: '1.234', description: 'bad' },
          ],
        },
        {
          id: 'B',
          name: 'Custom',
          currency: 'https://example.com/currency',
          balance: '1.00',
          'balance-date': 1,
        },
        { nope: true },
      ],
    })
    expect(r.accounts[0]!.transactions.map((t) => t.id)).toEqual(['g'])
    expect(r.accounts[0]!.problems).toHaveLength(1)
    expect(r.accounts[1]!.currency).toBeNull()
    expect(r.messages.some((m) => m.code === 'act.baddata')).toBe(true)
  })
  /**
   * Inputs:   something that is not an account set (a string)
   * Expected: throws "bad_response"
   */
  it('rejects a response that is not an account set', () => {
    expect(code(() => parseAccountSet('nope'))).toBe('bad_response')
  })
})
