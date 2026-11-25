import { describe, expect, it } from 'vitest'
import { createTransaction, linkTransfer, createAccount, updateAccount } from '../ledger/service.js'
import { IDS, makeLedgerWorld } from '../testing/ledgerWorld.js'
import { addMonths, cashFlow, lastDayOf, monthsFrom, netWorth, spending } from './service.js'

/**
 * Core reports over the ledger world (fakes). HOME has Checking and Savings (USD) and a Euro
 * account; "ann" edits HOME. All amounts are made up.
 */
function world() {
  const w = makeLedgerWorld()
  const add = (
    date: string,
    cents: number,
    category: string | null = null,
    accountId: string = IDS.CHECKING,
  ) =>
    createTransaction(w.deps, w.actors.ann, IDS.HOME, {
      accountId,
      date,
      amountCents: cents,
      description: 'x',
      splits: [
        {
          spaceId: IDS.HOME,
          categoryId: category ? w.category('HOME', category) : null,
          amountCents: cents,
        },
      ],
    })
  const balance = (accountId: string, date: string, balanceCents: number) =>
    w.repos.balances.upsert({
      id: `${accountId}-${date}`,
      accountId,
      date,
      balanceCents,
      source: 'manual',
    })
  return { w, add, balance }
}

describe('month arithmetic', () => {
  /**
   * Function: addMonths, lastDayOf, monthsFrom
   * Inputs:   moves across New Year; February 2032 (leap) and 2030; a range crossing a year
   * Expected: correct months and last days
   */
  it('handles year ends and leap years', () => {
    expect([addMonths('2030-12', 1), addMonths('2030-01', -13)]).toEqual(['2031-01', '2028-12'])
    expect([lastDayOf('2032-02'), lastDayOf('2030-02')]).toEqual(['2032-02-29', '2030-02-28'])
    expect(monthsFrom('2030-11', '2031-02')).toEqual(['2030-11', '2030-12', '2031-01', '2031-02'])
  })
})

describe('cashFlow', () => {
  /**
   * Function: cashFlow
   * Inputs:   January: $3,000 pay, $500 groceries and a $50 grocery refund; March: an
   *           uncategorized $200 deposit and $80 payment; a linked transfer between own accounts;
   *           a euro purchase; asked for January to March
   * Expected: January in 3000, out 450 (the refund lowers spending); February present and zero;
   *           March counts the uncategorized by direction (2 flagged); the transfer and the euros
   *           are left out, and one other-currency account is reported
   */
  it('shows money in and out for every month, categorized or not', () => {
    const { w, add } = world()
    add('2030-01-05', 300000, 'Paycheck')
    add('2030-01-10', -50000, 'Groceries')
    add('2030-01-20', 5000, 'Groceries')
    add('2030-03-02', 20000)
    add('2030-03-03', -8000)
    const out = add('2030-03-09', -100000)
    const into = add('2030-03-09', 100000, null, IDS.SAVINGS)
    linkTransfer(w.deps, w.actors.ann, IDS.HOME, out.id, into.id)
    add('2030-01-07', -7777, null, IDS.EUR)
    const r = cashFlow(w.repos, IDS.HOME, '2030-01', '2030-03')
    expect(r.months).toEqual([
      { month: '2030-01', inCents: 300000, outCents: 45000, netCents: 255000 },
      { month: '2030-02', inCents: 0, outCents: 0, netCents: 0 },
      { month: '2030-03', inCents: 20000, outCents: 8000, netCents: 12000 },
    ])
    expect(r.totals).toEqual({ inCents: 320000, outCents: 53000, netCents: 267000 })
    expect([r.uncategorizedCount, r.otherCurrencyAccounts]).toEqual([2, 1])
  })

  /**
   * Function: cashFlow with no categories at all (a brand-new household)
   * Inputs:   only uncategorized money
   * Expected: it still shows in and out, so the report works with no setup
   */
  it('works before anything has been categorized', () => {
    const { w, add } = world()
    add('2030-01-05', 1000)
    add('2030-01-06', -400)
    expect(cashFlow(w.repos, IDS.HOME, '2030-01', '2030-01').months[0]).toMatchObject({
      inCents: 1000,
      outCents: 400,
    })
  })
})

describe('spending', () => {
  /**
   * Function: spending
   * Inputs:   groceries $90, dining $30 with a $45 refund, pay, an uncategorized $10 payment and a
   *           $99 uncategorized deposit, one purchase outside the dates
   * Expected: Groceries first, then No category (payments only), then Dining at -$15; income and
   *           the deposit are not spending; the total is the sum of the lines
   */
  it('ranks spending by category and leaves income out', () => {
    const { w, add } = world()
    add('2030-01-05', -9000, 'Groceries')
    add('2030-01-06', -3000, 'Dining Out')
    add('2030-01-07', 4500, 'Dining Out')
    add('2030-01-08', 100000, 'Paycheck')
    add('2030-01-09', -1000)
    add('2030-01-10', 9900)
    add('2030-02-01', -5555, 'Groceries')
    const r = spending(w.repos, IDS.HOME, '2030-01-01', '2030-01-31')
    expect(r.lines.map((l) => [l.name, l.cents])).toEqual([
      ['Groceries', 9000],
      ['No category', 1000],
      ['Dining Out', -1500],
    ])
    expect(r.totalCents).toBe(8500)
  })
})

describe('netWorth', () => {
  /**
   * Function: netWorth
   * Inputs:   today 2030-03-15, 6 months; Checking $100 on Jan 10 and $150 on Mar 1; Savings $500
   *           from Feb 20; a new card owing $200 from Mar 5; a euro balance
   * Expected: points start at January (nothing earlier is known) and end today; each month uses
   *           the latest balance on or before its last day; the card counts as debt; accounts not
   *           yet known are reported as missing; euros are left out and reported
   */
  it('adds up what each account held at the end of each month', () => {
    const { w, balance } = world()
    const card = createAccount(w.deps, IDS.HOME, {
      name: 'Card',
      type: 'credit_card',
      includeInNetWorth: true,
    })
    balance(IDS.CHECKING, '2030-01-10', 10000)
    balance(IDS.CHECKING, '2030-03-01', 15000)
    balance(IDS.SAVINGS, '2030-02-20', 50000)
    balance(card.id, '2030-03-05', -20000)
    balance(IDS.EUR, '2030-01-01', 123456)
    const r = netWorth(w.repos, IDS.HOME, '2030-03-15', 6)
    expect(r.points).toEqual([
      { date: '2030-01-31', netCents: 10000, assetsCents: 10000, debtsCents: 0, missing: 2 },
      { date: '2030-02-28', netCents: 60000, assetsCents: 60000, debtsCents: 0, missing: 1 },
      { date: '2030-03-15', netCents: 45000, assetsCents: 65000, debtsCents: 20000, missing: 0 },
    ])
    expect(r.accounts.map((a) => [a.name, a.balanceCents])).toEqual(
      expect.arrayContaining([
        ['Checking', 15000],
        ['Card', -20000],
      ]),
    )
    expect(r.otherCurrencyAccounts).toBe(1)
  })

  /**
   * Function: netWorth with excluded and archived accounts
   * Inputs:   Savings taken out of net worth; Checking archived on 2030-02-10; today 2030-03-15
   * Expected: Savings never counts; Checking counts for January, not from February on, and isn't
   *           listed today; with nothing left, later months read zero
   */
  it('respects the net worth switch and keeps an archived account’s past', () => {
    const { w, balance } = world()
    balance(IDS.CHECKING, '2030-01-10', 10000)
    balance(IDS.SAVINGS, '2030-01-10', 50000)
    updateAccount(w.deps, IDS.HOME, IDS.SAVINGS, { includeInNetWorth: false })
    w.repos.accounts.update(IDS.CHECKING, { archivedAt: '2030-02-10T00:00:00.000Z' })
    const r = netWorth(w.repos, IDS.HOME, '2030-03-15', 3)
    expect(r.points.map((p) => [p.date, p.netCents])).toEqual([
      ['2030-01-31', 10000],
      ['2030-02-28', 0],
      ['2030-03-15', 0],
    ])
    expect(r.accounts.map((a) => a.name)).not.toContain('Checking')
  })

  /**
   * Function: netWorth with no balances
   * Inputs:   a Space whose accounts have never had a balance
   * Expected: no points, and the accounts are listed without a balance
   */
  it('has nothing to draw before any balance exists', () => {
    const { w } = world()
    const r = netWorth(w.repos, IDS.HOME, '2030-03-15', 12)
    expect(r.points).toEqual([])
    expect(r.accounts.every((a) => a.balanceCents === null)).toBe(true)
  })
})
