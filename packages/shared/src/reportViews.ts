/** Shapes of Pond's core reports, shared by the server and the web app. Money is integer cents. */

export interface CashFlowMonth {
  /** YYYY-MM */
  month: string
  inCents: number
  /** Spending as a positive number. */
  outCents: number
  netCents: number
}
export interface CashFlowReport {
  months: CashFlowMonth[]
  totals: { inCents: number; outCents: number; netCents: number }
  /** Splits with no category, counted by direction. */
  uncategorizedCount: number
  /** Accounts left out because they aren't in the Space's currency. */
  otherCurrencyAccounts: number
}

export interface SpendingLine {
  /** Null is "No category". */
  categoryId: string | null
  name: string
  /** Positive is spending; negative when refunds outweighed it. */
  cents: number
}
export interface SpendingReport {
  from: string
  to: string
  /** Largest first. */
  lines: SpendingLine[]
  totalCents: number
  otherCurrencyAccounts: number
}

export interface NetWorthPoint {
  /** The last day of a month, or today for the current month. */
  date: string
  netCents: number
  assetsCents: number
  /** What is owed, as a positive number. */
  debtsCents: number
  /** Accounts with no balance recorded yet on this date, so not counted. */
  missing: number
}
export interface NetWorthAccount {
  accountId: string
  name: string
  type: string
  balanceCents: number | null
  /** When that balance was recorded. */
  balanceDate: string | null
}
export interface NetWorthReport {
  /** Oldest first. Starts at the first month with any balance. */
  points: NetWorthPoint[]
  /** The accounts counted today. */
  accounts: NetWorthAccount[]
  otherCurrencyAccounts: number
}
