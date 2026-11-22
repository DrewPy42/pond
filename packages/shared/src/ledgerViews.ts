/**
 * Shapes of the ledger API responses, shared so the server and the web app can't drift apart.
 * (Request shapes are the zod schemas in ledger.ts.) Money is integer cents.
 */

export interface SplitView {
  id: string
  transactionId: string
  spaceId: string
  categoryId: string | null
  amountCents: number
  memo: string | null
  reimbursable: boolean
  reimbursedAt: string | null
}

/** What the Space that owns the account sees. */
export interface FullTransactionView {
  kind: 'full'
  id: string
  accountId: string
  accountName: string
  date: string
  amountCents: number
  descriptionRaw: string
  payee: string | null
  memo: string | null
  pending: boolean
  private: boolean
  needsReview: boolean
  source: 'simplefin' | 'manual' | 'csv'
  splits: SplitView[]
}

/** What another Space sees of a transaction that has a split there (data-model.md). */
export interface SharedTransactionView {
  kind: 'shared'
  id: string
  date: string
  descriptionRaw: string
  payee: string | null
  pending: boolean
  /** null when the transaction is private. */
  accountName: string | null
  /** null when the transaction is private. */
  totalCents: number | null
  /** Only the splits that land in the viewing Space. */
  splits: SplitView[]
  /** null when private. */
  otherSpacesCents: number | null
}

export type TransactionView = FullTransactionView | SharedTransactionView

export interface AccountView {
  id: string
  name: string
  nickname: string | null
  institutionName: string | null
  type: string
  currency: string
  isManual: boolean
  includeInNetWorth: boolean
  hidden: boolean
  lastFour: string | null
  archived: boolean
  balanceCents: number | null
  balanceDate: string | null
}

export interface CategoryView {
  id: string
  spaceId: string
  parentId: string | null
  name: string
  kind: 'income' | 'expense' | 'transfer'
  taxLine: string | null
  sortOrder: number
  archivedAt: string | null
}

export interface BalanceView {
  id: string
  accountId: string
  date: string
  balanceCents: number
  availableCents: number | null
  source: 'sync' | 'manual'
}

export interface TransferView {
  id: string
  fromTransactionId: string
  toTransactionId: string
}

/** A bank account brought in by a SimpleFIN connection. */
export interface ConnectionAccountView {
  id: string
  name: string
  type: string
  currency: string
  institutionName: string | null
  /** null until an admin gives it a Space; unassigned accounts stay hidden and aren't synced. */
  primarySpaceId: string | null
  syncEnabled: boolean
  hidden: boolean
}

/** A SimpleFIN connection. It never includes the Access URL, encrypted or not. */
export interface ConnectionView {
  id: string
  label: string
  status: 'active' | 'error' | 'revoked'
  lastSyncedAt: string | null
  lastError: string | null
  accounts: ConnectionAccountView[]
}
