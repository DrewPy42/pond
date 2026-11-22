/** What we keep of a SimpleFIN response (protocol: simplefin.org/protocol.html). Money is cents. */

export interface SimpleFinTransaction {
  /** Unique within an account. */
  id: string
  /** Epoch seconds. For pending transactions the bank may send 0. */
  postedEpoch: number
  amountCents: number
  description: string
  transactedEpoch: number | null
  pending: boolean
}

export interface SimpleFinAccount {
  id: string
  name: string
  connId: string | null
  /** ISO 4217 code, or null when the bank used a custom (URL) currency we don't support. */
  currency: string | null
  balanceCents: number
  availableCents: number | null
  balanceEpoch: number
  /** The institution's name, when the response includes it. */
  orgName: string | null
  transactions: SimpleFinTransaction[]
  /** Problems converting this account's data (it is skipped when non-empty). */
  problems: string[]
}

export interface SimpleFinMessage {
  code: string
  msg: string
  connId: string | null
  accountId: string | null
}

export interface SimpleFinResult {
  accounts: SimpleFinAccount[]
  /** Server-reported problems (`errlist`, or the deprecated `errors` strings). Already sanitized. */
  messages: SimpleFinMessage[]
}

export interface FetchOptions {
  /** Only transactions on/after this time. */
  startDate?: Date
  /** Include pending transactions. */
  pending?: boolean
  /** Accounts and balances only, no transactions. */
  balancesOnly?: boolean
}

/** The one door to the network. Real in production, scripted fake in tests. */
export interface SimpleFinClient {
  /** Exchange a one-time Setup Token for an Access URL (which holds credentials). */
  claim(setupToken: string): Promise<string>
  fetchAccounts(accessUrl: string, opts: FetchOptions): Promise<SimpleFinResult>
}

export type SimpleFinErrorCode =
  | 'invalid_token' // not base64, or not a usable claim URL
  | 'unsafe_url' // not https / points somewhere private
  | 'token_rejected' // 403 on claim: wrong, or already used (maybe compromised)
  | 'payment_required' // 402
  | 'auth_failed' // 403 on /accounts: access revoked
  | 'http_error'
  | 'bad_response'
  | 'network'

export class SimpleFinError extends Error {
  constructor(
    public code: SimpleFinErrorCode,
    message: string,
  ) {
    super(message)
  }
}
