import { describe, expect, it } from 'vitest'
import { descriptionsSimilar, epochToDate, planSync, toIncoming, type Incoming } from './plan'
import type { SplitRecord, TransactionRecord, TransactionWithSplits } from '../repos/types'
import { noon, sfTxn } from '../testing/fakeSimpleFin'

// Pure planning of a sync: plain objects in, a plan out. No repositories, no clock, no network.

const WINDOW = '2030-01-01'

const inc = (over: Partial<Incoming> & { externalId: string }): Incoming => ({
  date: '2030-01-10',
  postedAt: null,
  transactedAt: null,
  amountCents: -1000,
  description: 'COFFEE SHOP',
  pending: false,
  ...over,
})
const held = (
  id: string,
  over: Partial<TransactionRecord> = {},
  splits?: Partial<SplitRecord>[],
): TransactionWithSplits => ({
  txn: {
    id,
    accountId: 'A',
    externalId: id.toUpperCase(),
    source: 'simplefin',
    date: '2030-01-10',
    postedAt: null,
    transactedAt: null,
    amountCents: -1000,
    descriptionRaw: 'COFFEE SHOP',
    payee: null,
    memo: null,
    pending: false,
    status: 'active',
    private: false,
    needsReview: false,
    userEdited: false,
    supersededBy: null,
    importBatchId: null,
    ...over,
  },
  splits: (splits ?? [{}]).map((s, i) => ({
    id: `${id}-s${i}`,
    transactionId: id,
    spaceId: 'HOME',
    categoryId: null,
    amountCents: over.amountCents ?? -1000,
    memo: null,
    reimbursable: false,
    reimbursedAt: null,
    ...s,
  })),
  account: { id: 'A', name: 'Checking', primarySpaceId: 'HOME', currency: 'USD' },
})
const plan = (incoming: Incoming[], existing: TransactionWithSplits[] = []) =>
  planSync({ incoming, existing, windowStart: WINDOW })

describe('epochToDate(epochSeconds, timeZone) and toIncoming(tx, timeZone, nowEpoch)', () => {
  /**
   * Inputs:   2030-01-10 03:00 UTC viewed in UTC and in America/New_York
   * Expected: "2030-01-10" in UTC; "2030-01-09" in New York (still the evening before there)
   */
  it('turns an instant into a calendar day in the given time zone', () => {
    const t = Math.floor(Date.parse('2030-01-10T03:00:00Z') / 1000)
    expect(epochToDate(t, 'UTC')).toBe('2030-01-10')
    expect(epochToDate(t, 'America/New_York')).toBe('2030-01-09')
  })
  /**
   * Inputs:   a pending transaction with posted = 0 and transacted_at Jan 8; one with neither
   * Expected: dated by transacted_at (Jan 8); falls back to "now"; postedAt is null for both
   */
  it('dates a pending transaction by when it happened', () => {
    const a = toIncoming(
      sfTxn({ id: 'a', postedEpoch: 0, pending: true, transactedEpoch: noon('2030-01-08') }),
      'UTC',
      noon('2030-01-15'),
    )
    const b = toIncoming(
      sfTxn({ id: 'b', postedEpoch: 0, pending: true }),
      'UTC',
      noon('2030-01-15'),
    )
    expect([a.date, a.postedAt, b.date, b.postedAt]).toEqual([
      '2030-01-08',
      null,
      '2030-01-15',
      null,
    ])
  })
})

describe('descriptionsSimilar(a, b)', () => {
  /**
   * Inputs:   "STARBUCKS #1234" vs "Starbucks 1234 SEATTLE WA"; "AMAZON MKTPLACE" vs "AMZN Mktp US";
   *           "Shell Oil" vs "Whole Foods"; "" vs "x"
   * Expected: true (containment after cleanup); false (too few shared words); false; false
   */
  it('matches the same merchant text but not different merchants', () => {
    expect(descriptionsSimilar('STARBUCKS #1234', 'Starbucks 1234 SEATTLE WA')).toBe(true)
    expect(descriptionsSimilar('AMAZON MKTPLACE', 'AMZN Mktp US')).toBe(false)
    expect(descriptionsSimilar('Shell Oil', 'Whole Foods')).toBe(false)
    expect(descriptionsSimilar('', 'x')).toBe(false)
  })
})

describe('planSync: new, unchanged and changed transactions', () => {
  /**
   * Inputs:   one new transaction and nothing held
   * Expected: one insert, no carry-over, nothing else
   */
  it('inserts a transaction it has not seen', () => {
    const p = plan([inc({ externalId: 'N1' })])
    expect(p.inserts).toHaveLength(1)
    expect(p.inserts[0]!.carryFrom).toBeUndefined()
    expect([p.updates, p.removals, p.reviewFlags]).toEqual([[], [], []])
  })
  /**
   * Inputs:   the same transaction (same bank id) that we already hold, identical
   * Expected: an empty plan: syncing twice never duplicates or rewrites
   */
  it('does nothing for a transaction it already has', () => {
    const p = plan([inc({ externalId: 'T1' })], [held('t1')])
    expect(p).toEqual({ inserts: [], updates: [], removals: [], reviewFlags: [] })
  })
  /**
   * Inputs:   a held pending transaction whose bank id now arrives posted, with a new date and text
   * Expected: one update to pending=false, the new date and description; no insert
   */
  it('updates bank fields when a pending transaction posts under the same id', () => {
    const p = plan(
      [
        inc({
          externalId: 'T1',
          pending: false,
          date: '2030-01-11',
          description: 'COFFEE SHOP #9',
        }),
      ],
      [held('t1', { pending: true })],
    )
    expect(p.inserts).toEqual([])
    expect(p.updates[0]!.patch).toEqual({
      pending: false,
      date: '2030-01-11',
      descriptionRaw: 'COFFEE SHOP #9',
    })
    expect(p.updates[0]!.resplit).toBe(false)
  })
  /**
   * Inputs:   an amount change on a held transaction with one split; and on one with two splits
   * Expected: one split: update with resplit = true; two splits: no amount change, flagged for review
   */
  it('follows an amount change with a lone split, and flags it when several splits exist', () => {
    const one = plan([inc({ externalId: 'T1', amountCents: -1250 })], [held('t1')])
    expect(one.updates[0]).toMatchObject({ patch: { amountCents: -1250 }, resplit: true })
    const many = plan(
      [inc({ externalId: 'T2', amountCents: -1250 })],
      [held('t2', {}, [{ amountCents: -600 }, { amountCents: -400 }])],
    )
    expect(many.updates).toEqual([])
    expect(many.reviewFlags.map((f) => f.txn.id)).toEqual(['t2'])
  })
  /**
   * Inputs:   a transaction we marked removed that the bank sends again
   * Expected: update with status back to "active"
   */
  it('revives a removed transaction the bank sends again', () => {
    const p = plan([inc({ externalId: 'T1' })], [held('t1', { status: 'removed' })])
    expect(p.updates[0]!.patch).toEqual({ status: 'active' })
  })
})

describe('planSync: pending reconciliation (architecture.md, sync flow step 5)', () => {
  const pending = (over: Partial<TransactionRecord> = {}, splits?: Partial<SplitRecord>[]) =>
    held('p1', { pending: true, date: '2030-01-10', ...over }, splits)

  /**
   * Inputs:   a held pending (-1000, Jan 10, "COFFEE SHOP") that the bank no longer lists, and no
   *           posted match
   * Expected: the pending is marked for removal
   */
  it('removes a pending transaction the bank no longer lists', () => {
    const p = plan([], [pending()])
    expect(p.removals.map((r) => r.txn.id)).toEqual(['p1'])
  })
  /**
   * Inputs:   the same vanished pending, but the user edited it
   * Expected: it is not removed; it is flagged for review
   */
  it('keeps an edited pending transaction and flags it', () => {
    const p = plan([], [pending({ userEdited: true })])
    expect(p.removals).toEqual([])
    expect(p.reviewFlags.map((f) => f.txn.id)).toEqual(['p1'])
  })
  /**
   * Inputs:   a vanished pending older than the fetch window (Dec 20, window starts Jan 1)
   * Expected: left alone: the bank wasn't asked about that period, so absence means nothing
   */
  it('leaves pending transactions from before the fetch window alone', () => {
    const p = plan([], [pending({ date: '2029-12-20' })])
    expect(p).toEqual({ inserts: [], updates: [], removals: [], reviewFlags: [] })
  })
  /**
   * Inputs:   a vanished pending split -600 Groceries / -400 other, and a new posted transaction
   *           with a different bank id: same amount -1000, 2 days later, similar text
   * Expected: one insert carrying from the pending (so its splits and categories carry over);
   *           the pending is not separately removed (the carry-over retires it)
   */
  it("carries a pending transaction's splits to the posted one that replaces it", () => {
    const p1 = pending({}, [{ amountCents: -600, categoryId: 'groceries' }, { amountCents: -400 }])
    const p = plan(
      [inc({ externalId: 'POSTED-1', date: '2030-01-12', description: 'COFFEE SHOP 1234' })],
      [p1],
    )
    expect(p.inserts).toHaveLength(1)
    expect(p.inserts[0]!.carryFrom!.txn.id).toBe('p1')
    expect(p.removals).toEqual([])
  })
  /**
   * Inputs:   a posted candidate that differs by amount (-1001); by 6 days; by merchant; and one
   *           that is itself still pending
   * Expected: none carry over (they insert plain) and the vanished pending is removed
   */
  it('does not carry over on a mismatch in amount, date, text or pending state', () => {
    for (const other of [
      { amountCents: -1001 },
      { date: '2030-01-16' },
      { description: 'HARDWARE STORE' },
      { pending: true },
    ]) {
      const p = plan([inc({ externalId: 'X', ...other })], [pending()])
      expect(p.inserts[0]!.carryFrom, JSON.stringify(other)).toBeUndefined()
      expect(p.removals.map((r) => r.txn.id)).toEqual(['p1'])
    }
  })
  /**
   * Inputs:   a pending that was already marked removed in an earlier sync (not yet superseded),
   *           then the matching posted transaction arrives; and one already superseded
   * Expected: the removed one is still matched and carried over; the superseded one is not
   */
  it('matches a pending removed earlier, but never one already replaced', () => {
    const early = plan([inc({ externalId: 'POSTED' })], [pending({ status: 'removed' })])
    expect(early.inserts[0]!.carryFrom!.txn.id).toBe('p1')
    const done = plan(
      [inc({ externalId: 'POSTED' })],
      [pending({ status: 'removed', supersededBy: 'x' })],
    )
    expect(done.inserts[0]!.carryFrom).toBeUndefined()
  })
  /**
   * Inputs:   two identical vanished pendings (same amount and text) and one matching posted txn
   * Expected: the posted transaction claims only one; the other pending is removed (no double use)
   */
  it('lets one posted transaction claim only one pending', () => {
    const a = held('pa', { pending: true })
    const b = held('pb', { pending: true })
    const p = plan([inc({ externalId: 'POSTED' })], [a, b])
    expect(p.inserts[0]!.carryFrom).toBeDefined()
    expect(p.removals).toHaveLength(1)
  })
})
