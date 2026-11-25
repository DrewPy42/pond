import { describe, expect, it } from 'vitest'
import { BUSINESS_SEEDS, PERSONAL_SEEDS, seedsFor } from './categorySeeds'
import { checkSplits, defaultSplit } from './splits'
import { checkTransferPair, orientTransfer } from './transfers'
import { viewTransaction } from './visibility'
import type { SplitRecord, TransactionRecord } from '../repos/types'

// Pure ledger rules: plain functions, mock objects, no repositories at all.

const txn = (over: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id: 't1',
  accountId: 'A',
  externalId: null,
  source: 'manual',
  date: '2030-01-10',
  postedAt: null,
  transactedAt: null,
  amountCents: -6000,
  descriptionRaw: 'Team lunch',
  payee: 'Cafe',
  memo: 'secret memo',
  pending: false,
  status: 'active',
  private: false,
  needsReview: true,
  userEdited: false,
  supersededBy: null,
  importBatchId: null,
  ...over,
})
const split = (
  id: string,
  spaceId: string,
  amountCents: number,
  over: Partial<SplitRecord> = {},
): SplitRecord => ({
  id,
  transactionId: 't1',
  spaceId,
  categoryId: null,
  amountCents,
  memo: null,
  reimbursable: false,
  reimbursedAt: null,
  ...over,
})
const account = { id: 'A', name: 'Personal Visa', primarySpaceId: 'HOME', currency: 'USD' }

describe('checkSplits(txnAmountCents, splits)', () => {
  /**
   * Inputs:   amount -1000 with splits [-600, -400]
   * Expected: null (valid: they add up exactly)
   */
  it('accepts splits that add up exactly', () => {
    expect(checkSplits(-1000, [{ amountCents: -600 }, { amountCents: -400 }])).toBeNull()
  })
  /**
   * Inputs:   amount -1000 with splits [-600, -399]
   * Expected: "sum_mismatch" (one cent short is still wrong)
   */
  it('rejects splits that are off by a cent', () => {
    expect(checkSplits(-1000, [{ amountCents: -600 }, { amountCents: -399 }])).toBe('sum_mismatch')
  })
  /**
   * Inputs:   amount -1000 with no splits
   * Expected: "no_splits" (every transaction needs at least one)
   */
  it('rejects an empty split list', () => {
    expect(checkSplits(-1000, [])).toBe('no_splits')
  })
  /**
   * Inputs:   a fractional amount, and a fractional split (0.1 + 0.2 style float values)
   * Expected: "not_integer" for both (floats never enter ledger math)
   */
  it('rejects non-integer cents', () => {
    expect(checkSplits(-10.5, [{ amountCents: -10.5 }])).toBe('not_integer')
    expect(checkSplits(-1000, [{ amountCents: -999.5 }, { amountCents: -0.5 }])).toBe('not_integer')
  })
  /**
   * Inputs:   amount +500 with splits [+800, -300] (a refund partly reallocated)
   * Expected: null (negative and positive splits may mix as long as they sum to the amount)
   */
  it('allows mixed-sign splits that sum correctly', () => {
    expect(checkSplits(500, [{ amountCents: 800 }, { amountCents: -300 }])).toBeNull()
  })
})

describe('defaultSplit(spaceId, amountCents)', () => {
  /**
   * Inputs:   Space "HOME", amount -2599
   * Expected: one uncategorized split in HOME for -2599
   */
  it('covers the whole amount, uncategorized, in the given Space', () => {
    expect(defaultSplit('HOME', -2599)).toEqual({
      spaceId: 'HOME',
      categoryId: null,
      amountCents: -2599,
    })
  })
})

describe('viewTransaction(txn, splits, account, viewingSpaceId)', () => {
  const splits = [
    split('s1', 'HOME', -4000),
    split('s2', 'BIZ', -2000, { memo: 'client lunch', categoryId: 'meals' }),
  ]

  /**
   * Inputs:   the transaction viewed from HOME, which owns the account
   * Expected: the full view: account name, total -6000, memo, review flag and both splits
   */
  it('shows everything to the Space that owns the account', () => {
    const v = viewTransaction(txn(), splits, account, 'HOME')!
    expect(v).toMatchObject({
      kind: 'full',
      accountName: 'Personal Visa',
      amountCents: -6000,
      memo: 'secret memo',
      needsReview: true,
    })
    expect(v.kind === 'full' && v.splits).toHaveLength(2)
  })

  /**
   * Inputs:   the same, non-private transaction viewed from BIZ (no access to HOME)
   * Expected: BIZ's own split (-2000 with memo), date/payee/description, the account name, the
   *           total -6000 and "other Spaces" -4000; but NOT the memo, review flag, source or
   *           account id
   */
  it('shows another Space its own split plus the allowed context when not private', () => {
    const v = viewTransaction(txn(), splits, account, 'BIZ')!
    expect(v).toEqual({
      kind: 'shared',
      id: 't1',
      date: '2030-01-10',
      descriptionRaw: 'Team lunch',
      payee: 'Cafe',
      pending: false,
      accountName: 'Personal Visa',
      totalCents: -6000,
      splits: [splits[1]],
      otherSpacesCents: -4000,
    })
    expect(JSON.stringify(v)).not.toContain('secret memo')
    expect(JSON.stringify(v)).not.toContain('"accountId"')
  })

  /**
   * Inputs:   the same transaction marked private, viewed from BIZ
   * Expected: account name, total and the "other Spaces" amount are all null; own split, date,
   *           payee and description remain
   */
  it('hides account name, total and other splits when the transaction is private', () => {
    const v = viewTransaction(txn({ private: true }), splits, account, 'BIZ')!
    expect(v).toMatchObject({
      kind: 'shared',
      accountName: null,
      totalCents: null,
      otherSpacesCents: null,
      payee: 'Cafe',
    })
    expect(v.kind === 'shared' && v.splits.map((s) => s.id)).toEqual(['s2'])
  })

  /**
   * Inputs:   the transaction viewed from a Space with no split in it (and no account)
   * Expected: null (it must not appear there at all)
   */
  it('returns nothing to a Space with no stake', () => {
    expect(viewTransaction(txn(), splits, account, 'OTHER')).toBeNull()
  })
})

describe('checkTransferPair(a, b) and orientTransfer(a, b)', () => {
  const side = (
    id: string,
    accountId: string,
    amountCents: number,
    over: Partial<TransactionRecord> = {},
    currency = 'USD',
  ) => ({
    txn: txn({ id, accountId, amountCents, ...over }),
    account: { id: accountId, currency },
  })

  /**
   * Inputs:   -5000 on account A and +5000 on account B, both USD, both active
   * Expected: null (a valid transfer)
   */
  it('accepts equal and opposite amounts on different accounts', () => {
    expect(checkTransferPair(side('t1', 'A', -5000), side('t2', 'B', 5000))).toBeNull()
  })
  /**
   * Inputs:   the same transaction twice; two transactions on the same account
   * Expected: "same_transaction"; "same_account"
   */
  it('rejects a transaction with itself and two on one account', () => {
    expect(checkTransferPair(side('t1', 'A', -5000), side('t1', 'A', -5000))).toBe(
      'same_transaction',
    )
    expect(checkTransferPair(side('t1', 'A', -5000), side('t2', 'A', 5000))).toBe('same_account')
  })
  /**
   * Inputs:   -5000 with +4999; -5000 with -5000; 0 with 0
   * Expected: "not_opposite" each time
   */
  it('rejects amounts that are not equal and opposite', () => {
    expect(checkTransferPair(side('t1', 'A', -5000), side('t2', 'B', 4999))).toBe('not_opposite')
    expect(checkTransferPair(side('t1', 'A', -5000), side('t2', 'B', -5000))).toBe('not_opposite')
    expect(checkTransferPair(side('t1', 'A', 0), side('t2', 'B', 0))).toBe('not_opposite')
  })
  /**
   * Inputs:   a USD account with a EUR account; a removed transaction
   * Expected: "currency_mismatch" (no conversion in v1); "not_active"
   */
  it('rejects mixed currencies and removed transactions', () => {
    expect(checkTransferPair(side('t1', 'A', -5000), side('t2', 'B', 5000, {}, 'EUR'))).toBe(
      'currency_mismatch',
    )
    expect(
      checkTransferPair(side('t1', 'A', -5000, { status: 'removed' }), side('t2', 'B', 5000)),
    ).toBe('not_active')
  })
  /**
   * Inputs:   the pair given in either order
   * Expected: orientTransfer always returns from = the negative (money out), to = the positive
   */
  it('orients a pair as money-out then money-in', () => {
    const out = side('t1', 'A', -5000)
    const inn = side('t2', 'B', 5000)
    expect(orientTransfer(inn, out)).toEqual({ from: out, to: inn })
    expect(orientTransfer(out, inn)).toEqual({ from: out, to: inn })
  })
})

describe('category seeds (seedsFor(type))', () => {
  /**
   * Inputs:   the personal and business seed lists
   * Expected: no duplicate names within a list; each has a "Transfer" category of kind transfer;
   *           seedsFor picks the right list by Space type
   */
  it('have unique names and a Transfer category', () => {
    for (const list of [PERSONAL_SEEDS, BUSINESS_SEEDS]) {
      const names = list.map((s) => s.name)
      expect(new Set(names).size).toBe(names.length)
      expect(list.find((s) => s.name === 'Transfer')?.kind).toBe('transfer')
    }
    expect(seedsFor('personal')).toBe(PERSONAL_SEEDS)
    expect(seedsFor('business')).toBe(BUSINESS_SEEDS)
  })
  /**
   * Function: BUSINESS_SEEDS
   * Inputs:   the general business starter list
   * Expected: no category has a tax line or mentions a tax form or percentage; Meals is plain "Meals"
   */
  it('gives a new business plain category names with no tax form attached', () => {
    for (const s of BUSINESS_SEEDS) {
      expect(s.taxLine, s.name).toBeUndefined()
      expect(s.name).not.toMatch(/schedule|deductible|%/i)
    }
    expect(BUSINESS_SEEDS.map((s) => s.name)).toContain('Meals')
  })
})
