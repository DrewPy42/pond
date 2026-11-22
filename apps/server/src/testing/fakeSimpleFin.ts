import type {
  FetchOptions,
  SimpleFinAccount,
  SimpleFinClient,
  SimpleFinResult,
  SimpleFinTransaction,
} from '../simplefin/types.js'

/**
 * A scripted stand-in for SimpleFIN: tests say what the bank "returns" and then check what we
 * asked. No network. Call `.accounts([...])` for the next responses, or `.fail(error)`.
 */
export class FakeSimpleFin implements SimpleFinClient {
  accessUrl = 'https://user:secret-pass@bridge.simplefin.test/simplefin'
  private claimError: Error | null = null
  private result: SimpleFinResult | Error = { accounts: [], messages: [] }
  claims: string[] = []
  fetches: { accessUrl: string; opts: FetchOptions }[] = []

  rejectClaim(error: Error): this {
    this.claimError = error
    return this
  }
  /** What the bank returns from now on. */
  returns(accounts: SimpleFinAccount[], messages: SimpleFinResult['messages'] = []): this {
    this.result = { accounts, messages }
    return this
  }
  fail(error: Error): this {
    this.result = error
    return this
  }

  async claim(setupToken: string): Promise<string> {
    this.claims.push(setupToken)
    if (this.claimError) throw this.claimError
    return this.accessUrl
  }
  async fetchAccounts(accessUrl: string, opts: FetchOptions): Promise<SimpleFinResult> {
    this.fetches.push({ accessUrl, opts })
    if (this.result instanceof Error) throw this.result
    return this.result
  }
}

/** Epoch seconds for noon UTC on a calendar day, so dates are the same in any time zone. */
export const noon = (date: string): number => Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000)

export function sfTxn(over: Partial<SimpleFinTransaction> & { id: string }): SimpleFinTransaction {
  return {
    postedEpoch: noon('2030-01-10'),
    amountCents: -1000,
    description: 'COFFEE SHOP',
    transactedEpoch: null,
    pending: false,
    ...over,
  }
}

export function sfAccount(over: Partial<SimpleFinAccount> & { id: string }): SimpleFinAccount {
  return {
    name: `Account ${over.id}`,
    connId: 'conn-1',
    currency: 'USD',
    balanceCents: 100000,
    availableCents: null,
    balanceEpoch: noon('2030-01-15'),
    orgName: 'Test Bank',
    transactions: [],
    problems: [],
    ...over,
  }
}
