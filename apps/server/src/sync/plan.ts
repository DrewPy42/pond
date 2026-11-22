import type { SimpleFinTransaction } from '../simplefin/types.js'
import type { TransactionPatch, TransactionWithSplits } from '../repos/types.js'

/**
 * Decides what to do with one account's incoming SimpleFIN transactions, as plain data. No
 * database, no clock, no network: `planSync` is given what we have and what the bank sent, and
 * returns a plan the sync service then applies. Rules are in docs/architecture.md ("SimpleFIN
 * sync flow", steps 4 and 5).
 */

export interface Incoming {
  externalId: string
  /** Calendar day, YYYY-MM-DD, in the household's time zone. */
  date: string
  postedAt: string | null
  transactedAt: string | null
  amountCents: number
  description: string
  pending: boolean
}

export interface PlannedInsert {
  incoming: Incoming
  /** A pending transaction this posted one replaces: its splits and categories carry over. */
  carryFrom?: TransactionWithSplits
}
export interface PlannedUpdate {
  existing: TransactionWithSplits
  patch: TransactionPatch
  /** The amount changed and there is exactly one split: it follows the new amount. */
  resplit: boolean
}
export interface SyncPlan {
  inserts: PlannedInsert[]
  updates: PlannedUpdate[]
  /** Pending transactions that vanished: marked removed. */
  removals: TransactionWithSplits[]
  /** Transactions needing a person's eye (edited pendings that vanished, ambiguous amount changes). */
  reviewFlags: TransactionWithSplits[]
}

export const CARRY_OVER_DAYS = 5

export function epochToDate(epochSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochSeconds * 1000))
}

/** Converts a SimpleFIN transaction. A pending one may have posted = 0; use when it happened. */
export function toIncoming(tx: SimpleFinTransaction, timeZone: string, nowEpoch: number): Incoming {
  const when = tx.postedEpoch > 0 ? tx.postedEpoch : (tx.transactedEpoch ?? nowEpoch)
  return {
    externalId: tx.id,
    date: epochToDate(when, timeZone),
    postedAt: tx.postedEpoch > 0 ? new Date(tx.postedEpoch * 1000).toISOString() : null,
    transactedAt: tx.transactedEpoch ? new Date(tx.transactedEpoch * 1000).toISOString() : null,
    amountCents: tx.amountCents,
    description: tx.description,
    pending: tx.pending,
  }
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** "Looks like the same merchant text": equal, one contains the other, or most words shared. */
export function descriptionsSimilar(a: string, b: string): boolean {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return false
  if (x === y || x.includes(y) || y.includes(x)) return true
  const tx = new Set(x.split(' ').filter((t) => t.length >= 2))
  const ty = new Set(y.split(' ').filter((t) => t.length >= 2))
  if (tx.size === 0 || ty.size === 0) return false
  const shared = [...tx].filter((t) => ty.has(t)).length
  return shared / (tx.size + ty.size - shared) >= 0.5
}

const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000)
const daysBetween = (a: string, b: string) => Math.abs(dayNumber(a) - dayNumber(b))

export function planSync(input: {
  incoming: Incoming[]
  /** Everything we hold for the account on/after `windowStart`, any status. */
  existing: TransactionWithSplits[]
  /** First day of the fetch window (YYYY-MM-DD). Pendings older than this weren't asked about. */
  windowStart: string
}): SyncPlan {
  const { incoming, existing, windowStart } = input
  const byExternal = new Map(
    existing.flatMap((e) => (e.txn.externalId ? [[e.txn.externalId, e] as const] : [])),
  )
  const seen = new Set<string>()
  const updates: PlannedUpdate[] = []
  const reviewFlags = new Map<string, TransactionWithSplits>()
  const fresh: Incoming[] = []

  for (const inc of incoming) {
    seen.add(inc.externalId)
    const ex = byExternal.get(inc.externalId)
    if (!ex) {
      fresh.push(inc)
      continue
    }
    const t = ex.txn
    const patch: TransactionPatch = {}
    if (inc.date !== t.date) patch.date = inc.date
    if (inc.pending !== t.pending) patch.pending = inc.pending
    if (inc.description !== t.descriptionRaw) patch.descriptionRaw = inc.description
    if (inc.postedAt !== t.postedAt) patch.postedAt = inc.postedAt
    if (inc.transactedAt !== t.transactedAt) patch.transactedAt = inc.transactedAt
    if (t.status === 'removed') patch.status = 'active' // the bank sent it again
    let resplit = false
    if (inc.amountCents !== t.amountCents) {
      if (ex.splits.length === 1) {
        patch.amountCents = inc.amountCents
        resplit = true
      } else {
        // Several splits and a new total: we can't guess how to divide it. Leave it for a person.
        reviewFlags.set(t.id, ex)
      }
    }
    if (Object.keys(patch).length > 0) updates.push({ existing: ex, patch, resplit })
  }

  // Pending transactions we hold that the bank no longer lists (inside the fetch window), or
  // that were already removed, but not yet replaced by a posted one.
  const orphans = existing.filter(
    (e) =>
      e.txn.pending &&
      e.txn.source === 'simplefin' &&
      e.txn.externalId !== null &&
      e.txn.supersededBy === null &&
      !seen.has(e.txn.externalId) &&
      (e.txn.status === 'removed' || e.txn.date >= windowStart),
  )

  const claimed = new Set<string>()
  const inserts: PlannedInsert[] = []
  for (const inc of fresh) {
    let carryFrom: TransactionWithSplits | undefined
    if (!inc.pending) {
      let best: { e: TransactionWithSplits; days: number } | undefined
      for (const e of orphans) {
        if (claimed.has(e.txn.id)) continue
        if (e.txn.amountCents !== inc.amountCents) continue
        const days = daysBetween(e.txn.date, inc.date)
        if (days > CARRY_OVER_DAYS) continue
        if (!descriptionsSimilar(e.txn.descriptionRaw, inc.description)) continue
        if (!best || days < best.days) best = { e, days }
      }
      if (best) {
        carryFrom = best.e
        claimed.add(best.e.txn.id)
      }
    }
    inserts.push({ incoming: inc, carryFrom })
  }

  const removals: TransactionWithSplits[] = []
  for (const e of orphans) {
    if (claimed.has(e.txn.id) || e.txn.status === 'removed') continue
    if (e.txn.userEdited) reviewFlags.set(e.txn.id, e)
    else removals.push(e)
  }

  return { inserts, updates, removals, reviewFlags: [...reviewFlags.values()] }
}
