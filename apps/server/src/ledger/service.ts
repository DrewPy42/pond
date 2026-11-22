import type {
  AccountView,
  CreateAccountInput,
  SplitInputBody,
  TransactionQuery,
  UpdateAccountInput,
  UpdateTransactionInput,
} from '@pond/shared'
import type {
  AccountRecord,
  BalanceSnapshotRecord,
  CategoryRecord,
  NewSplit,
  Repos,
  TransactionWithSplits,
} from '../repos/types.js'
import { SplitInvariantError } from '../repos/types.js'
import { seedsFor } from './categorySeeds.js'
import { checkTransferPair, orientTransfer } from './transfers.js'
import { viewTransaction, type TransactionView } from './visibility.js'

/**
 * Ledger business rules. Everything here talks to data only through `repos`, so it is tested on
 * in-memory fakes. Route handlers stay thin: they authorize the Space (createSpaceRouter),
 * validate input (zod), call one of these, and map LedgerError to an HTTP response.
 */

export class LedgerError extends Error {
  constructor(
    public status: number,
    public code: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

export interface Actor {
  id: string
  isAdmin: boolean
}
export interface Deps {
  repos: Repos
  newId: () => string
  now: () => Date
}

const today = (d: Deps) => d.now().toISOString().slice(0, 10)
const notFound = () => new LedgerError(404, 'not_found')

/** Admins, owners and editors may change money data in a Space. */
export function canEditSpace(repos: Repos, actor: Actor, spaceId: string): boolean {
  if (actor.isAdmin) return true
  const role = repos.spaces.getRole(spaceId, actor.id)
  return role === 'owner' || role === 'editor'
}

/** Turns the repository's split-invariant error into a client-facing 400. */
function translate<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof SplitInvariantError) {
      throw new LedgerError(400, 'splits_do_not_balance', { problem: e.problem })
    }
    throw e
  }
}

// ---------- Accounts and balances ----------

export type { AccountView }

const accountView = (a: AccountRecord, latest?: BalanceSnapshotRecord): AccountView => ({
  id: a.id,
  name: a.name,
  nickname: a.nickname,
  institutionName: a.institutionName,
  type: a.type,
  currency: a.currency,
  isManual: a.isManual,
  includeInNetWorth: a.includeInNetWorth,
  hidden: a.hidden,
  lastFour: a.lastFour,
  archived: a.archivedAt !== null,
  balanceCents: latest?.balanceCents ?? null,
  balanceDate: latest?.date ?? null,
})

function accountInSpace(repos: Repos, spaceId: string, accountId: string): AccountRecord {
  const a = repos.accounts.findById(accountId)
  if (!a || a.primarySpaceId !== spaceId) throw notFound()
  return a
}

export function listAccounts(d: Deps, spaceId: string, includeArchived = false): AccountView[] {
  const list = d.repos.accounts.listForSpace(spaceId, { includeArchived })
  const latest = new Map(
    d.repos.balances.latestForAccounts(list.map((a) => a.id)).map((b) => [b.accountId, b]),
  )
  return list.map((a) => accountView(a, latest.get(a.id)))
}

export function getAccount(d: Deps, spaceId: string, accountId: string): AccountView {
  const a = accountInSpace(d.repos, spaceId, accountId)
  return accountView(a, d.repos.balances.latestForAccounts([a.id])[0])
}

export function createAccount(d: Deps, spaceId: string, input: CreateAccountInput): AccountView {
  const space = d.repos.spaces.findById(spaceId)
  if (!space) throw notFound()
  const id = d.newId()
  d.repos.transaction(() => {
    d.repos.accounts.create({
      id,
      name: input.name,
      type: input.type,
      currency: input.currency ?? space.currency,
      nickname: input.nickname ?? null,
      institutionName: input.institutionName ?? null,
      lastFour: input.lastFour ?? null,
      includeInNetWorth: input.includeInNetWorth,
      primarySpaceId: spaceId,
      isManual: true,
    })
    if (input.openingBalanceCents !== undefined) {
      d.repos.balances.upsert({
        id: d.newId(),
        accountId: id,
        date: input.openingBalanceDate ?? today(d),
        balanceCents: input.openingBalanceCents,
        source: 'manual',
      })
    }
  })
  return getAccount(d, spaceId, id)
}

export function updateAccount(
  d: Deps,
  spaceId: string,
  accountId: string,
  input: UpdateAccountInput,
): AccountView {
  accountInSpace(d.repos, spaceId, accountId)
  const { archived, ...rest } = input
  d.repos.accounts.update(accountId, {
    ...rest,
    ...(archived === undefined ? {} : { archivedAt: archived ? d.now().toISOString() : null }),
  })
  return getAccount(d, spaceId, accountId)
}

/** Manual accounts have no bank feed, so balances are recorded by hand, one per day. */
export function setBalance(
  d: Deps,
  spaceId: string,
  accountId: string,
  date: string,
  input: { balanceCents: number; availableCents?: number | null },
): BalanceSnapshotRecord {
  accountInSpace(d.repos, spaceId, accountId)
  d.repos.balances.upsert({
    id: d.newId(),
    accountId,
    date,
    balanceCents: input.balanceCents,
    availableCents: input.availableCents ?? null,
    source: 'manual',
  })
  return d.repos.balances.listForAccount(accountId).find((b) => b.date === date)!
}

export function listBalances(d: Deps, spaceId: string, accountId: string): BalanceSnapshotRecord[] {
  accountInSpace(d.repos, spaceId, accountId)
  return d.repos.balances.listForAccount(accountId, { limit: 400 })
}

// ---------- Categories ----------

export function listCategories(
  d: Deps,
  spaceId: string,
  includeArchived = false,
): CategoryRecord[] {
  return d.repos.categories.listForSpace(spaceId, { includeArchived })
}

export function createCategory(
  d: Deps,
  spaceId: string,
  input: { name: string; kind: CategoryRecord['kind']; taxLine?: string; sortOrder?: number },
): CategoryRecord {
  const id = d.newId()
  d.repos.categories.create({ id, spaceId, ...input })
  return d.repos.categories.findById(id)!
}

export function updateCategory(
  d: Deps,
  spaceId: string,
  categoryId: string,
  input: {
    name?: string
    kind?: CategoryRecord['kind']
    taxLine?: string | null
    sortOrder?: number
    archived?: boolean
  },
): CategoryRecord {
  const c = d.repos.categories.findById(categoryId)
  if (!c || c.spaceId !== spaceId) throw notFound()
  const { archived, ...rest } = input
  d.repos.categories.update(categoryId, {
    ...rest,
    ...(archived === undefined ? {} : { archivedAt: archived ? d.now().toISOString() : null }),
  })
  return d.repos.categories.findById(categoryId)!
}

/** Gives a new Space its starter categories (Schedule C list for business Spaces). */
export function seedCategories(d: Deps, spaceId: string, type: 'personal' | 'business'): void {
  seedsFor(type).forEach((seed, i) => {
    d.repos.categories.create({
      id: d.newId(),
      spaceId,
      name: seed.name,
      kind: seed.kind,
      taxLine: seed.taxLine,
      sortOrder: i,
    })
  })
}

/** For Spaces that predate categories: seed any Space that has never had one. Idempotent. */
export function seedMissingCategories(d: Deps): number {
  let seeded = 0
  for (const space of d.repos.spaces.listAll()) {
    if (d.repos.categories.listForSpace(space.id, { includeArchived: true }).length === 0) {
      seedCategories(d, space.id, space.type)
      seeded++
    }
  }
  return seeded
}

// ---------- Transactions ----------

/**
 * Checks each split of a write and turns the request into rows. The actor must be able to edit
 * every Space a split lands in, and a category must belong to the split's own Space.
 * (The sum-to-amount rule is enforced by the repository itself.)
 */
function buildSplits(d: Deps, actor: Actor, input: SplitInputBody[]): NewSplit[] {
  return input.map((s) => {
    if (!d.repos.spaces.findById(s.spaceId)) throw new LedgerError(400, 'unknown_space')
    if (!canEditSpace(d.repos, actor, s.spaceId)) throw new LedgerError(403, 'forbidden_space')
    if (s.categoryId) {
      const c = d.repos.categories.findById(s.categoryId)
      if (!c || c.spaceId !== s.spaceId || c.archivedAt !== null) {
        throw new LedgerError(400, 'invalid_category')
      }
    }
    return {
      id: d.newId(),
      spaceId: s.spaceId,
      amountCents: s.amountCents,
      categoryId: s.categoryId ?? null,
      memo: s.memo ?? null,
      reimbursable: s.reimbursable ?? false,
    }
  })
}

function viewOf(found: TransactionWithSplits, spaceId: string): TransactionView {
  const v = viewTransaction(found.txn, found.splits, found.account, spaceId)
  if (!v) throw notFound()
  return v
}

/** The transaction if `spaceId` can see it, and whether it is on one of that Space's accounts. */
function visibleTxn(d: Deps, spaceId: string, txnId: string) {
  const found = d.repos.transactions.findById(txnId)
  if (!found) throw notFound()
  const own = found.account.primarySpaceId === spaceId
  if (!own && !found.splits.some((s) => s.spaceId === spaceId)) throw notFound()
  return { found, own }
}

/** Editing needs the transaction to be on one of this Space's accounts. */
function editableTxn(d: Deps, spaceId: string, txnId: string): TransactionWithSplits {
  const { found, own } = visibleTxn(d, spaceId, txnId)
  if (!own) throw new LedgerError(403, 'forbidden')
  return found
}

export function createTransaction(
  d: Deps,
  actor: Actor,
  spaceId: string,
  input: {
    accountId: string
    date: string
    amountCents: number
    description: string
    payee?: string
    memo?: string
    pending?: boolean
    splits?: SplitInputBody[]
  },
): TransactionView {
  const account = accountInSpace(d.repos, spaceId, input.accountId)
  // Bank-fed accounts get their transactions from the bank; typing them too would duplicate them.
  if (!account.isManual) throw new LedgerError(409, 'synced_account')
  const splits = buildSplits(
    d,
    actor,
    input.splits ?? [{ spaceId, amountCents: input.amountCents }],
  )
  const id = d.newId()
  translate(() =>
    d.repos.transactions.create(
      {
        id,
        accountId: input.accountId,
        source: 'manual',
        date: input.date,
        amountCents: input.amountCents,
        descriptionRaw: input.description,
        payee: input.payee ?? null,
        memo: input.memo ?? null,
        pending: input.pending ?? false,
      },
      splits,
    ),
  )
  return viewOf(d.repos.transactions.findById(id)!, spaceId)
}

export function updateTransaction(
  d: Deps,
  actor: Actor,
  spaceId: string,
  txnId: string,
  input: UpdateTransactionInput,
): TransactionView {
  const found = editableTxn(d, spaceId, txnId)
  const { splits: splitInput, description, ...rest } = input
  const amountChanges =
    input.amountCents !== undefined && input.amountCents !== found.txn.amountCents

  if (amountChanges && d.repos.transfers.findByTransaction(txnId)) {
    throw new LedgerError(409, 'linked_transfer') // unlink first; the pair must stay equal and opposite
  }

  let splits: NewSplit[] | undefined
  if (splitInput) {
    splits = buildSplits(d, actor, splitInput)
  } else if (amountChanges) {
    // One split covering the whole amount can follow the new total; more than one is ambiguous.
    if (found.splits.length !== 1) throw new LedgerError(400, 'splits_required')
    const only = found.splits[0]!
    splits = [{ ...only, id: d.newId(), amountCents: input.amountCents! }]
  }

  translate(() =>
    d.repos.transactions.update(
      txnId,
      {
        ...rest,
        userEdited: true,
        ...(description === undefined ? {} : { descriptionRaw: description }),
      },
      splits,
    ),
  )
  return viewOf(d.repos.transactions.findById(txnId)!, spaceId)
}

/** Soft delete (data-model.md): the row stays for history. Only manual entries; bank-fed ones come from the bank. */
export function removeTransaction(d: Deps, spaceId: string, txnId: string): void {
  const found = editableTxn(d, spaceId, txnId)
  if (found.txn.source !== 'manual') throw new LedgerError(409, 'not_manual')
  d.repos.transaction(() => {
    const link = d.repos.transfers.findByTransaction(txnId)
    if (link) d.repos.transfers.delete(link.id)
    d.repos.transactions.update(txnId, { status: 'removed' })
  })
}

export function getTransaction(d: Deps, spaceId: string, txnId: string) {
  const { found, own } = visibleTxn(d, spaceId, txnId)
  const link = own ? d.repos.transfers.findByTransaction(txnId) : undefined
  return {
    transaction: viewOf(found, spaceId),
    transfer: link
      ? {
          id: link.id,
          fromTransactionId: link.fromTransactionId,
          toTransactionId: link.toTransactionId,
        }
      : null,
  }
}

export function listTransactions(d: Deps, spaceId: string, q: TransactionQuery) {
  const { limit, offset, ...filters } = q
  const { rows, total } = d.repos.transactions.listForSpace(spaceId, filters, { limit, offset })
  const transactions = rows.flatMap((r) => {
    const v = viewTransaction(r.txn, r.splits, r.account, spaceId)
    return v ? [v] : []
  })
  return { transactions, total, limit, offset }
}

// ---------- Transfers ----------

/** Links a money-out transaction and a money-in transaction on different accounts as one transfer. */
export function linkTransfer(d: Deps, actor: Actor, spaceId: string, aId: string, bId: string) {
  const load = (id: string) => {
    const found = d.repos.transactions.findById(id)
    const acctSpace = found?.account.primarySpaceId
    // Not found, or on an account the actor can't edit: say "not found" so nothing leaks.
    if (!found || !acctSpace || !canEditSpace(d.repos, actor, acctSpace)) throw notFound()
    return { txn: found.txn, account: found.account }
  }
  const a = load(aId)
  const b = load(bId)
  if (a.account.primarySpaceId !== spaceId && b.account.primarySpaceId !== spaceId) throw notFound()
  const problem = checkTransferPair(a, b)
  if (problem) throw new LedgerError(400, 'cannot_link', { problem })
  if (d.repos.transfers.findByTransaction(aId) || d.repos.transfers.findByTransaction(bId)) {
    throw new LedgerError(409, 'already_linked')
  }
  const { from, to } = orientTransfer(a, b)
  const id = d.newId()
  d.repos.transfers.create({
    id,
    fromTransactionId: from.txn.id,
    toTransactionId: to.txn.id,
    createdBy: 'user',
  })
  return { id, fromTransactionId: from.txn.id, toTransactionId: to.txn.id }
}

export function unlinkTransfer(d: Deps, actor: Actor, spaceId: string, txnId: string): void {
  editableTxn(d, spaceId, txnId)
  const link = d.repos.transfers.findByTransaction(txnId)
  if (!link) throw notFound()
  // Unlinking changes the other side too, so the actor must be able to edit both accounts.
  for (const id of [link.fromTransactionId, link.toTransactionId]) {
    const side = d.repos.transactions.findById(id)
    const sp = side?.account.primarySpaceId
    if (!sp || !canEditSpace(d.repos, actor, sp)) throw new LedgerError(403, 'forbidden')
  }
  d.repos.transfers.delete(link.id)
}
