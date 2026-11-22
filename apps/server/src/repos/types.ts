import type { Role } from '../types.js'

/**
 * Repository interfaces: the only way routes, middleware and services read or write data.
 * Real implementations (repos/drizzle.ts) wrap Drizzle; tests use in-memory fakes
 * (testing/fakeRepos.ts). Both must pass the same contract suite (testing/repoContract.ts), so
 * a fake can't quietly behave differently from the database. All methods are synchronous
 * because better-sqlite3 is.
 *
 * Records are plain objects, deliberately not Drizzle's inferred types, so nothing above this
 * layer depends on the database library.
 */

export interface UserRecord {
  id: string
  username: string
  displayName: string
  email: string | null
  passwordHash: string
  totpSecretEnc: string | null
  totpEnabledAt: string | null
  isAdmin: boolean
  status: 'active' | 'disabled'
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}
export interface NewUser {
  id: string
  username: string
  displayName: string
  email?: string | null
  passwordHash: string
  isAdmin: boolean
}
export type UserPatch = Partial<
  Pick<
    UserRecord,
    | 'displayName'
    | 'email'
    | 'passwordHash'
    | 'totpSecretEnc'
    | 'totpEnabledAt'
    | 'isAdmin'
    | 'status'
    | 'lastLoginAt'
  >
>

/** Thrown by `create` when the username is already taken. */
export class DuplicateError extends Error {}
/** Thrown when a row refers to a parent that doesn't exist (foreign key). */
export class MissingParentError extends Error {}
/** Thrown when a write would break "splits sum exactly to the transaction amount". */
export class SplitInvariantError extends Error {
  constructor(public problem: 'no_splits' | 'not_integer' | 'sum_mismatch') {
    super(problem)
  }
}

export interface UserRepo {
  count(): number
  findById(id: string): UserRecord | undefined
  findByUsername(username: string): UserRecord | undefined
  /** Ordered by username. */
  list(): UserRecord[]
  /** Throws DuplicateError if the username exists. */
  create(user: NewUser): void
  /** Atomic: creates the user only if there are no users yet. Returns whether it did. */
  createIfNoUsers(user: NewUser): boolean
  update(id: string, patch: UserPatch): void
  /** Active admins other than `exceptId` (used to protect the last admin). */
  countActiveAdminsExcept(exceptId: string): number
}

export interface RecoveryCodeRecord {
  id: string
  userId: string
  codeHash: string
  usedAt: string | null
}
export interface RecoveryCodeRepo {
  /** Deletes the user's existing codes and stores these hashes. */
  replaceForUser(userId: string, hashes: { id: string; codeHash: string }[]): void
  findUnused(userId: string, codeHash: string): RecoveryCodeRecord | undefined
  markUsed(id: string, at: string): void
  countUnused(userId: string): number
}

export interface SessionRecord {
  id: string
  userId: string
  csrfHash: string
  expiresAt: string
  absoluteExpiresAt: string
  lastSeenAt: string
  reauthAt: string | null
  ip: string | null
  userAgent: string | null
}
export interface SessionRepo {
  /** Throws MissingParentError if the user doesn't exist. */
  create(session: Omit<SessionRecord, 'reauthAt'>): void
  findWithUser(id: string): { session: SessionRecord; user: UserRecord } | undefined
  touch(id: string, lastSeenAt: string, expiresAt: string): void
  setReauth(id: string, at: string): void
  delete(id: string): void
  /** Deletes all of a user's sessions, optionally keeping one. */
  deleteForUser(userId: string, exceptId?: string): void
}

export interface SpaceRecord {
  id: string
  name: string
  type: 'personal' | 'business'
  currency: string
  archivedAt: string | null
}
export interface MemberView {
  userId: string
  username: string
  displayName: string
  role: Role
}
export interface SpaceRepo {
  create(space: Omit<SpaceRecord, 'archivedAt'>): void
  findById(id: string): SpaceRecord | undefined
  /** Ordered by name. */
  listAll(): SpaceRecord[]
  /** Spaces the user is a member of, with their role. Ordered by name. */
  listForUser(userId: string): { space: SpaceRecord; role: Role }[]
  update(id: string, patch: Partial<Pick<SpaceRecord, 'name' | 'archivedAt'>>): void

  getRole(spaceId: string, userId: string): Role | undefined
  /** Ordered by username. */
  listMembers(spaceId: string): MemberView[]
  /** Adds or changes a membership. Throws MissingParentError for an unknown space or user. */
  setMember(spaceId: string, userId: string, role: Role): 'added' | 'changed'
  removeMember(spaceId: string, userId: string): void
  countOwners(spaceId: string): number
}

export interface AuditRecord {
  id: string
  at: string
  actorType: 'user' | 'system' | 'lilypad'
  actorId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  spaceId: string | null
  meta: Record<string, unknown> | null
}
export interface AuditRepo {
  add(entry: AuditRecord): void
  /** Newest first. `before` is an ISO timestamp (exclusive). */
  list(opts: { limit: number; before?: string }): AuditRecord[]
}

// ---------- Ledger (M2) ----------

export type AccountType =
  | 'checking'
  | 'savings'
  | 'credit_card'
  | 'loan'
  | 'brokerage'
  | 'retirement'
  | 'cash'
  | 'property'
  | 'other'

export interface AccountRecord {
  id: string
  connectionId: string | null
  externalId: string | null
  institutionName: string | null
  name: string
  nickname: string | null
  type: AccountType
  currency: string
  primarySpaceId: string | null
  isManual: boolean
  includeInNetWorth: boolean
  syncEnabled: boolean
  hidden: boolean
  lastFour: string | null
  archivedAt: string | null
}
export type NewAccount = Pick<AccountRecord, 'id' | 'name' | 'type' | 'currency'> &
  Partial<
    Pick<
      AccountRecord,
      | 'institutionName'
      | 'nickname'
      | 'primarySpaceId'
      | 'isManual'
      | 'includeInNetWorth'
      | 'lastFour'
      | 'hidden'
      | 'connectionId'
      | 'externalId'
      | 'syncEnabled'
    >
  >
export type AccountPatch = Partial<
  Pick<
    AccountRecord,
    | 'name'
    | 'nickname'
    | 'institutionName'
    | 'type'
    | 'includeInNetWorth'
    | 'hidden'
    | 'lastFour'
    | 'archivedAt'
    | 'primarySpaceId'
    | 'syncEnabled'
  >
>
export interface AccountRepo {
  create(account: NewAccount): void
  findById(id: string): AccountRecord | undefined
  /** Accounts whose primary Space is `spaceId`, ordered by name. Archived ones only on request. */
  listForSpace(spaceId: string, opts?: { includeArchived?: boolean }): AccountRecord[]
  update(id: string, patch: AccountPatch): void
  findByExternal(connectionId: string, externalId: string): AccountRecord | undefined
  /** Every account a connection brought in, assigned or not. Ordered by name. */
  listForConnection(connectionId: string): AccountRecord[]
}

export interface BalanceSnapshotRecord {
  id: string
  accountId: string
  date: string
  balanceCents: number
  availableCents: number | null
  source: 'sync' | 'manual'
}
export interface BalanceRepo {
  /** One snapshot per account per day: inserts, or replaces the amounts for that day. */
  upsert(
    s: Omit<BalanceSnapshotRecord, 'availableCents'> & { availableCents?: number | null },
  ): void
  /** Newest first. */
  listForAccount(accountId: string, opts?: { limit?: number }): BalanceSnapshotRecord[]
  /** The most recent snapshot for each given account (accounts with none are omitted). */
  latestForAccounts(accountIds: string[]): BalanceSnapshotRecord[]
}

export interface CategoryRecord {
  id: string
  spaceId: string
  parentId: string | null
  name: string
  kind: 'income' | 'expense' | 'transfer'
  taxLine: string | null
  sortOrder: number
  archivedAt: string | null
}
export type NewCategory = Pick<CategoryRecord, 'id' | 'spaceId' | 'name' | 'kind'> &
  Partial<Pick<CategoryRecord, 'parentId' | 'taxLine' | 'sortOrder'>>
export interface CategoryRepo {
  create(category: NewCategory): void
  findById(id: string): CategoryRecord | undefined
  /** Ordered by kind (income, expense, transfer), then sortOrder, then name. */
  listForSpace(spaceId: string, opts?: { includeArchived?: boolean }): CategoryRecord[]
  update(
    id: string,
    patch: Partial<
      Pick<CategoryRecord, 'name' | 'kind' | 'taxLine' | 'sortOrder' | 'parentId' | 'archivedAt'>
    >,
  ): void
}

export interface TransactionRecord {
  id: string
  accountId: string
  externalId: string | null
  source: 'simplefin' | 'manual' | 'csv'
  date: string
  postedAt: string | null
  transactedAt: string | null
  amountCents: number
  descriptionRaw: string
  payee: string | null
  memo: string | null
  pending: boolean
  status: 'active' | 'removed'
  private: boolean
  needsReview: boolean
  userEdited: boolean
  supersededBy: string | null
}
export type NewTransaction = Pick<
  TransactionRecord,
  'id' | 'accountId' | 'source' | 'date' | 'amountCents' | 'descriptionRaw'
> &
  Partial<
    Pick<
      TransactionRecord,
      | 'externalId'
      | 'postedAt'
      | 'transactedAt'
      | 'payee'
      | 'memo'
      | 'pending'
      | 'private'
      | 'needsReview'
      | 'userEdited'
    >
  >
export type TransactionPatch = Partial<
  Pick<
    TransactionRecord,
    | 'date'
    | 'amountCents'
    | 'descriptionRaw'
    | 'payee'
    | 'memo'
    | 'pending'
    | 'private'
    | 'needsReview'
    | 'status'
    | 'userEdited'
    | 'postedAt'
    | 'transactedAt'
    | 'supersededBy'
  >
>

export interface SplitRecord {
  id: string
  transactionId: string
  spaceId: string
  categoryId: string | null
  amountCents: number
  memo: string | null
  reimbursable: boolean
  reimbursedAt: string | null
}
export type NewSplit = Pick<SplitRecord, 'id' | 'spaceId' | 'amountCents'> &
  Partial<Pick<SplitRecord, 'categoryId' | 'memo' | 'reimbursable'>>

export interface TransactionWithSplits {
  txn: TransactionRecord
  splits: SplitRecord[]
  account: Pick<AccountRecord, 'id' | 'name' | 'primarySpaceId' | 'currency'>
}
export interface TransactionFilters {
  accountId?: string
  categoryId?: string
  /** Inclusive calendar days, YYYY-MM-DD. */
  from?: string
  to?: string
  /** Case-insensitive text match on description, payee and memo. */
  q?: string
}
export interface TransactionRepo {
  /**
   * Stores a transaction and its splits together. Throws SplitInvariantError unless there is at
   * least one split and the splits sum exactly to the amount; DuplicateError for a repeated
   * (account, externalId); MissingParentError for an unknown account, Space or category.
   */
  create(txn: NewTransaction, splits: NewSplit[]): void
  findById(id: string): TransactionWithSplits | undefined
  /**
   * Applies `patch`. When the amount changes or `splits` is given, the final splits must still
   * balance (SplitInvariantError otherwise) and `splits`, if given, replace the old ones.
   */
  update(id: string, patch: TransactionPatch, splits?: NewSplit[]): void
  /**
   * Active transactions visible to a Space: those on its accounts, plus those with a split in
   * it. Newest first (date, then id, descending), with the total before paging.
   */
  listForSpace(
    spaceId: string,
    filters: TransactionFilters,
    page: { limit: number; offset: number },
  ): { rows: TransactionWithSplits[]; total: number }
  /** A bank-fed transaction by the bank's own id, in any status. */
  findByExternalId(accountId: string, externalId: string): TransactionWithSplits | undefined
  /** Every transaction on the account dated on/after `fromDate` (YYYY-MM-DD), any status. */
  listForAccountSince(accountId: string, fromDate: string): TransactionWithSplits[]
  countForAccount(accountId: string): number
  /** Ids of active transactions whose splits don't balance (should always be empty). */
  findInvariantViolations(): string[]
}

export interface TransferLinkRecord {
  id: string
  fromTransactionId: string
  toTransactionId: string
  createdBy: 'user' | 'rule' | 'auto'
}
export interface TransferRepo {
  /** Throws DuplicateError if either transaction is already linked. */
  create(link: TransferLinkRecord): void
  findByTransaction(transactionId: string): TransferLinkRecord | undefined
  delete(id: string): void
}

// ---------- SimpleFIN connections (M3) ----------

export interface ConnectionRecord {
  id: string
  label: string
  /** Encrypted Access URL; null after the connection is revoked. */
  accessUrlEnc: string | null
  createdBy: string
  status: 'active' | 'error' | 'revoked'
  lastSyncedAt: string | null
  lastError: string | null
}
export interface ConnectionRepo {
  /** Throws MissingParentError if `createdBy` isn't a user. */
  create(c: Pick<ConnectionRecord, 'id' | 'label' | 'accessUrlEnc' | 'createdBy'>): void
  findById(id: string): ConnectionRecord | undefined
  /** Ordered by label. */
  list(): ConnectionRecord[]
  update(
    id: string,
    patch: Partial<
      Pick<ConnectionRecord, 'label' | 'accessUrlEnc' | 'status' | 'lastSyncedAt' | 'lastError'>
    >,
  ): void
}

export interface Repos {
  users: UserRepo
  recoveryCodes: RecoveryCodeRepo
  sessions: SessionRepo
  spaces: SpaceRepo
  audit: AuditRepo
  connections: ConnectionRepo
  accounts: AccountRepo
  balances: BalanceRepo
  categories: CategoryRepo
  transactions: TransactionRepo
  transfers: TransferRepo
  system: { schemaVersion(): number }
  /** Several writes as one unit. Real: a SQLite transaction (rolls back if `fn` throws). */
  transaction<T>(fn: () => T): T
}
