import type { ConnectionAccountView, ConnectionView } from '@pond/shared'
import { recordAudit } from '../audit.js'
import type { Crypto } from '../crypto/index.js'
import { LedgerError, announceTransaction, type Actor, type Deps } from '../ledger/service.js'
import type {
  AccountRecord,
  AccountType,
  ConnectionRecord,
  NewSplit,
  TransactionWithSplits,
} from '../repos/types.js'
import type { SimpleFinAccount, SimpleFinClient } from '../simplefin/types.js'
import { SimpleFinError } from '../simplefin/types.js'
import { applyRulesToTransaction } from '../rules/service.js'
import { epochToDate, planSync, toIncoming } from './plan.js'

/**
 * SimpleFIN connection and sync logic (docs/architecture.md, "SimpleFIN sync flow"). Data goes
 * through repositories and the network through `client`, so all of this is tested on fakes.
 * The Access URL is decrypted only inside `syncConnection` / `discoverAccounts`, used for the
 * request, and never logged, returned or put in the audit log.
 */

export interface SyncDeps extends Deps {
  crypto: Crypto
  client: SimpleFinClient
  /** IANA time zone used to turn epoch times into calendar days (e.g. "America/New_York"). */
  timeZone: string
}

/** How far back the first sync reaches. Re-check against a real account (scope-v1.md open item). */
export const FIRST_SYNC_DAYS = 90
/** Later syncs re-read this much overlap so late-posting and changed transactions are caught. */
export const OVERLAP_DAYS = 14
/** A person pressing "Sync now" repeatedly would burn SimpleFIN's request allowance. */
export const MANUAL_SYNC_MIN_SECONDS = 300

const DAY = 86_400_000
const shiftDate = (d: string, days: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)

/** Turns a SimpleFIN failure into a client-facing error. */
export function toLedgerError(e: unknown): LedgerError {
  if (!(e instanceof SimpleFinError)) throw e
  const status =
    { invalid_token: 400, unsafe_url: 400, token_rejected: 400 }[e.code as 'invalid_token'] ?? 502
  return new LedgerError(status, e.code, { message: e.message })
}

/** A best guess from the account name; the admin can change it afterwards. */
export function guessAccountType(name: string): AccountType {
  const n = name.toLowerCase()
  if (/credit|visa|mastercard|amex|discover|\bcard\b/.test(n)) return 'credit_card'
  if (/saving|money market/.test(n)) return 'savings'
  if (/check|everyday|current/.test(n)) return 'checking'
  if (/mortgage|loan|line of credit|heloc/.test(n)) return 'loan'
  if (/401|403|ira\b|roth|retire|pension/.test(n)) return 'retirement'
  if (/brokerage|invest|stock|trading/.test(n)) return 'brokerage'
  return 'other'
}

// ---------- Views ----------

export type { ConnectionAccountView, ConnectionView }

const accountView = (a: AccountRecord): ConnectionAccountView => ({
  id: a.id,
  name: a.name,
  type: a.type,
  currency: a.currency,
  institutionName: a.institutionName,
  primarySpaceId: a.primarySpaceId,
  syncEnabled: a.syncEnabled,
  hidden: a.hidden,
})

/** Never includes the Access URL, encrypted or not. */
export function connectionView(d: Deps, c: ConnectionRecord): ConnectionView {
  return {
    id: c.id,
    label: c.label,
    status: c.status,
    lastSyncedAt: c.lastSyncedAt,
    lastError: c.lastError,
    accounts: d.repos.accounts.listForConnection(c.id).map(accountView),
  }
}

export const listConnections = (d: Deps): ConnectionView[] =>
  d.repos.connections.list().map((c) => connectionView(d, c))

function requireConnection(d: Deps, id: string): ConnectionRecord {
  const c = d.repos.connections.findById(id)
  if (!c) throw new LedgerError(404, 'not_found')
  return c
}

const audit = (
  d: Deps,
  actor: Actor,
  action: string,
  targetId: string,
  meta?: Record<string, unknown>,
) =>
  recordAudit(
    d.repos.audit,
    { actorId: actor.id, action, targetType: 'connection', targetId, meta },
    d.now(),
    d.newId,
  )

// ---------- Connect and discover ----------

/** Creates the (unassigned, hidden) local account for a bank account we haven't seen. */
function addDiscovered(d: Deps, conn: ConnectionRecord, a: SimpleFinAccount): boolean {
  if (a.currency === null) return false // a custom currency we don't support in v1
  d.repos.accounts.create({
    id: d.newId(),
    name: a.name,
    type: guessAccountType(a.name),
    currency: a.currency,
    institutionName: a.orgName,
    connectionId: conn.id,
    externalId: a.id,
    isManual: false,
    hidden: true, // stays out of sight until an admin gives it a Space
    syncEnabled: false,
  })
  return true
}

export interface DiscoveryResult {
  found: number
  added: number
  warnings: string[]
}

/** Step 2: list the accounts behind the token (balances only) and add the new ones, unassigned. */
export async function discoverAccounts(
  d: SyncDeps,
  connectionId: string,
): Promise<DiscoveryResult> {
  const conn = requireConnection(d, connectionId)
  if (conn.status === 'revoked' || !conn.accessUrlEnc) throw new LedgerError(409, 'revoked')
  const result = await d.client.fetchAccounts(d.crypto.decrypt(conn.accessUrlEnc), {
    balancesOnly: true,
  })
  let added = 0
  const warnings = result.messages.map((m) => m.msg)
  for (const a of result.accounts) {
    if (d.repos.accounts.findByExternal(conn.id, a.id)) continue
    if (addDiscovered(d, conn, a)) added++
    else warnings.push(`${a.name}: unsupported currency`)
  }
  return { found: result.accounts.length, added, warnings }
}

/**
 * Step 1: exchange the Setup Token for an Access URL and store it encrypted. The token is
 * single-use, so the connection is saved before anything else can fail; if discovery then
 * fails, the connection is kept with the error shown so the Access URL isn't lost.
 */
export async function connectSimpleFin(
  d: SyncDeps,
  actor: Actor,
  input: { setupToken: string; label: string },
): Promise<{ connection: ConnectionView; discovery: DiscoveryResult | null }> {
  let accessUrl: string
  try {
    accessUrl = await d.client.claim(input.setupToken)
  } catch (e) {
    throw toLedgerError(e)
  }
  const id = d.newId()
  d.repos.connections.create({
    id,
    label: input.label,
    accessUrlEnc: d.crypto.encrypt(accessUrl),
    createdBy: actor.id,
  })
  audit(d, actor, 'connection.created', id, { label: input.label })

  let discovery: DiscoveryResult | null = null
  try {
    discovery = await discoverAccounts(d, id)
  } catch (e) {
    const msg = e instanceof SimpleFinError ? e.message : 'Could not list the accounts.'
    d.repos.connections.update(id, {
      status: e instanceof SimpleFinError && e.code === 'auth_failed' ? 'error' : 'active',
      lastError: msg,
    })
  }
  return { connection: connectionView(d, d.repos.connections.findById(id)!), discovery }
}

/** Gives a bank account a primary Space (or none), which turns its syncing on (or off). */
export function assignAccount(
  d: Deps,
  actor: Actor,
  connectionId: string,
  accountId: string,
  input: { primarySpaceId: string | null; name?: string; type?: AccountType },
): ConnectionAccountView {
  requireConnection(d, connectionId)
  const a = d.repos.accounts.findById(accountId)
  if (!a || a.connectionId !== connectionId) throw new LedgerError(404, 'not_found')
  if (input.primarySpaceId !== null && !d.repos.spaces.findById(input.primarySpaceId)) {
    throw new LedgerError(400, 'unknown_space')
  }
  if (input.primarySpaceId !== a.primarySpaceId && d.repos.transactions.countForAccount(a.id) > 0) {
    // Its history already sits in the old Space's books; moving it is a later feature.
    throw new LedgerError(409, 'has_transactions')
  }
  const assigned = input.primarySpaceId !== null
  d.repos.accounts.update(a.id, {
    primarySpaceId: input.primarySpaceId,
    hidden: !assigned,
    syncEnabled: assigned,
    ...(input.name ? { name: input.name } : {}),
    ...(input.type ? { type: input.type } : {}),
  })
  audit(d, actor, 'connection.account_assigned', connectionId, {
    accountId,
    spaceId: input.primarySpaceId,
  })
  return accountView(d.repos.accounts.findById(a.id)!)
}

/** Disconnect: forget the Access URL and stop syncing. History stays. */
export function revokeConnection(d: Deps, actor: Actor, connectionId: string): void {
  const c = requireConnection(d, connectionId)
  d.repos.transaction(() => {
    d.repos.connections.update(c.id, { status: 'revoked', accessUrlEnc: null })
    for (const a of d.repos.accounts.listForConnection(c.id))
      d.repos.accounts.update(a.id, { syncEnabled: false })
  })
  audit(d, actor, 'connection.revoked', c.id, { label: c.label })
}

// ---------- The sync itself ----------

export interface SyncSummary {
  ok: boolean
  /** Why the whole sync failed (no data was fetched). */
  error: string | null
  accountsSynced: number
  newAccounts: number
  inserted: number
  updated: number
  removed: number
  carriedOver: number
  flagged: number
  /** New transactions a rule changed (category, payee, Space, transfer link). */
  ruled: number
  warnings: string[]
}

const emptySummary = (): SyncSummary => ({
  ok: true,
  error: null,
  accountsSynced: 0,
  newAccounts: 0,
  inserted: 0,
  updated: 0,
  removed: 0,
  carriedOver: 0,
  flagged: 0,
  ruled: 0,
  warnings: [],
})

/** Steps 4 and 5 for one account: upsert, carry over pending splits, retire vanished pendings. */
function applyAccount(
  d: SyncDeps,
  acct: AccountRecord,
  sf: SimpleFinAccount,
  windowStart: string,
  nowEpoch: number,
  s: SyncSummary,
): { created: string[]; changed: string[] } {
  const created: string[] = []
  const changed: string[] = []
  const incoming = sf.transactions.map((t) => toIncoming(t, d.timeZone, nowEpoch))
  // List a little before the window so a day-boundary difference can't hide an existing row.
  const existing = d.repos.transactions.listForAccountSince(acct.id, shiftDate(windowStart, -3))
  const plan = planSync({ incoming, existing, windowStart })
  const spaceId = acct.primarySpaceId!
  const unlink = (t: TransactionWithSplits) => {
    const link = d.repos.transfers.findByTransaction(t.txn.id)
    if (link) d.repos.transfers.delete(link.id)
  }

  for (const { incoming: inc, carryFrom } of plan.inserts) {
    const id = d.newId()
    const splits: NewSplit[] = carryFrom
      ? carryFrom.splits.map((sp) => ({
          id: d.newId(),
          spaceId: sp.spaceId,
          categoryId: sp.categoryId,
          amountCents: sp.amountCents,
          memo: sp.memo,
          reimbursable: sp.reimbursable,
        }))
      : [{ id: d.newId(), spaceId, amountCents: inc.amountCents }]
    d.repos.transactions.create(
      {
        id,
        accountId: acct.id,
        externalId: inc.externalId,
        source: 'simplefin',
        date: inc.date,
        postedAt: inc.postedAt,
        transactedAt: inc.transactedAt,
        amountCents: inc.amountCents,
        descriptionRaw: inc.description,
        pending: inc.pending,
        payee: carryFrom?.txn.payee ?? null,
        memo: carryFrom?.txn.memo ?? null,
        private: carryFrom?.txn.private ?? false,
        userEdited: carryFrom?.txn.userEdited ?? false,
      },
      splits,
    )
    s.inserted++
    created.push(id)
    if (carryFrom) {
      unlink(carryFrom)
      d.repos.transactions.update(carryFrom.txn.id, { status: 'removed', supersededBy: id })
      s.carriedOver++
    } else if (applyRulesToTransaction(d, id).changed) {
      // A brand-new bank transaction: let the Space's rules categorize it. (One that inherited a
      // pending transaction's splits is already categorized by a person, so rules leave it.)
      s.ruled++
    }
  }
  for (const u of plan.updates) {
    const only = u.existing.splits[0]
    const splits: NewSplit[] | undefined =
      u.resplit && only
        ? [
            {
              id: d.newId(),
              spaceId: only.spaceId,
              categoryId: only.categoryId,
              memo: only.memo,
              reimbursable: only.reimbursable,
              amountCents: u.patch.amountCents!,
            },
          ]
        : undefined
    d.repos.transactions.update(u.existing.txn.id, u.patch, splits)
    s.updated++
    changed.push(u.existing.txn.id)
  }
  for (const r of plan.removals) {
    unlink(r)
    d.repos.transactions.update(r.txn.id, { status: 'removed' })
    s.removed++
    changed.push(r.txn.id)
  }
  for (const f of plan.reviewFlags) {
    if (!f.txn.needsReview) d.repos.transactions.update(f.txn.id, { needsReview: true })
    s.flagged++
  }
  // Step 6: today's balance. SimpleFIN only reports the current one, so this is our history.
  d.repos.balances.upsert({
    id: d.newId(),
    accountId: acct.id,
    date: epochToDate(nowEpoch, d.timeZone),
    balanceCents: sf.balanceCents,
    availableCents: sf.availableCents,
    source: 'sync',
  })
  return { created, changed }
}

/** Steps 3 to 7 for one connection. Failures are recorded on the connection, not thrown. */
export async function syncConnection(
  d: SyncDeps,
  connectionId: string,
  opts: { manual?: boolean } = {},
): Promise<SyncSummary> {
  const conn = requireConnection(d, connectionId)
  if (conn.status === 'revoked' || !conn.accessUrlEnc) throw new LedgerError(409, 'revoked')
  const now = d.now()

  if (opts.manual && conn.lastSyncedAt) {
    const age = (now.getTime() - Date.parse(conn.lastSyncedAt)) / 1000
    if (age < MANUAL_SYNC_MIN_SECONDS) {
      throw new LedgerError(429, 'sync_too_soon', {
        retryAfterSeconds: Math.ceil(MANUAL_SYNC_MIN_SECONDS - age),
      })
    }
  }

  const s = emptySummary()
  const start = conn.lastSyncedAt
    ? new Date(Date.parse(conn.lastSyncedAt) - OVERLAP_DAYS * DAY)
    : new Date(now.getTime() - FIRST_SYNC_DAYS * DAY)
  const nowEpoch = Math.floor(now.getTime() / 1000)

  let result
  try {
    result = await d.client.fetchAccounts(d.crypto.decrypt(conn.accessUrlEnc), {
      startDate: start,
      pending: true,
    })
  } catch (e) {
    const msg = e instanceof SimpleFinError ? e.message : 'The sync failed unexpectedly.'
    d.repos.connections.update(conn.id, {
      status: e instanceof SimpleFinError && e.code === 'auth_failed' ? 'error' : conn.status,
      lastError: msg,
    })
    return { ...s, ok: false, error: msg }
  }

  const windowStart = epochToDate(Math.floor(start.getTime() / 1000), d.timeZone)
  let skipped = false
  const syncedSpaces = new Set<string>()
  for (const sf of result.accounts) {
    const acct = d.repos.accounts.findByExternal(conn.id, sf.id)
    if (!acct) {
      if (addDiscovered(d, conn, sf)) s.newAccounts++
      else s.warnings.push(`${sf.name}: unsupported currency`)
      continue
    }
    if (!acct.syncEnabled || !acct.primarySpaceId) continue
    if (sf.problems.length > 0) {
      s.warnings.push(...sf.problems) // skip the whole account rather than half-sync it
      skipped = true
      continue
    }
    if (sf.currency !== acct.currency) {
      s.warnings.push(`${acct.name}: currency changed from ${acct.currency}; skipped`)
      skipped = true
      continue
    }
    const done = d.repos.transaction(() => applyAccount(d, acct, sf, windowStart, nowEpoch, s))
    s.accountsSynced++
    // Announce only after the data is committed.
    for (const id of done.created) announceTransaction(d, 'transaction.created', id)
    for (const id of done.changed) announceTransaction(d, 'transaction.updated', id)
    syncedSpaces.add(acct.primarySpaceId)
  }

  s.warnings.push(...result.messages.map((m) => m.msg))
  for (const spaceId of syncedSpaces) d.events?.emit({ type: 'sync.completed', spaceId })
  const authProblem = result.messages.some((m) => /^(gen|con)\.auth/.test(m.code))
  d.repos.connections.update(conn.id, {
    // Don't move the window forward past an account we had to skip: its data is still owed.
    ...(skipped ? {} : { lastSyncedAt: now.toISOString() }),
    lastError: s.warnings.length ? s.warnings.join('; ').slice(0, 500) : null,
    status: authProblem ? 'error' : 'active',
  })
  return s
}

/** What the scheduler runs: every live connection, one after another, never throwing. */
export async function syncAll(d: SyncDeps): Promise<Record<string, SyncSummary>> {
  const out: Record<string, SyncSummary> = {}
  for (const c of d.repos.connections.list()) {
    if (c.status === 'revoked' || !c.accessUrlEnc) continue
    try {
      out[c.id] = await syncConnection(d, c.id)
    } catch (e) {
      out[c.id] = { ...emptySummary(), ok: false, error: e instanceof Error ? e.message : 'failed' }
    }
  }
  return out
}
