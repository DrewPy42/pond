import type { SplitSumRow } from '@pond/sdk'
import { describe, expect, it } from 'vitest'
import {
  countedCents,
  csvText,
  isRealDate,
  maskTaxId,
  periodsFor,
  profitAndLoss,
  taxSummary,
  taxYearOf,
  taxYearRange,
} from './logic'

describe('tax years and periods', () => {
  /**
   * Function: taxYearRange, taxYearOf
   * Inputs:   a calendar tax year; one starting in April; one starting in March (ends in a leap
   *           February); dates either side of an April start
   * Expected: Jan 1 to Dec 31; Apr 1 to Mar 31 of the next year; ending Feb 29, 2032; 31 March
   *           belongs to the year before, 1 April to the new one
   */
  it('handles tax years that do not start in January', () => {
    expect(taxYearRange(2030, 1)).toEqual({ from: '2030-01-01', to: '2030-12-31' })
    expect(taxYearRange(2030, 4)).toEqual({ from: '2030-04-01', to: '2031-03-31' })
    expect(taxYearRange(2031, 3).to).toBe('2032-02-29')
    expect(taxYearOf('2030-03-31', 4)).toBe(2029)
    expect(taxYearOf('2030-04-01', 4)).toBe(2030)
  })

  /**
   * Function: periodsFor
   * Inputs:   today 2030-02-14 with a tax year starting in April
   * Expected: this month = February; this quarter = January to March (the tax year's 4th quarter);
   *           this tax year = Apr 2029 to Mar 2030; last = Apr 2028 to Mar 2029
   */
  it('offers quick picks that follow the tax year', () => {
    expect(periodsFor('2030-02-14', 4).map((p) => [p.key, p.from, p.to])).toEqual([
      ['month', '2030-02-01', '2030-02-28'],
      ['quarter', '2030-01-01', '2030-03-31'],
      ['year', '2029-04-01', '2030-03-31'],
      ['last_year', '2028-04-01', '2029-03-31'],
    ])
  })

  /**
   * Function: periodsFor (quarters that cross a calendar year)
   * Inputs:   today 2030-01-10 with a tax year starting in November
   * Expected: this quarter runs 2029-11-01 to 2030-01-31
   */
  it('lets a quarter cross New Year', () => {
    expect(periodsFor('2030-01-10', 11)[1]).toMatchObject({ from: '2029-11-01', to: '2030-01-31' })
  })

  /**
   * Function: isRealDate
   * Inputs:   2030-02-28, 2030-02-29, "2030-1-1"
   * Expected: only the first is real
   */
  it('rejects dates that are not on the calendar', () => {
    expect([isRealDate('2030-02-28'), isRealDate('2030-02-29'), isRealDate('2030-1-1')]).toEqual([
      true,
      false,
      false,
    ])
  })
})

const categories = [
  { id: 'sales', name: 'Sales', taxLine: null },
  { id: 'meals', name: 'Meals', taxLine: 'Line 24b' },
  { id: 'rent', name: 'Rent', taxLine: 'Line 20' },
  { id: 'ads', name: 'Advertising', taxLine: 'Line 8' },
  { id: 'misc', name: 'Misc', taxLine: '  ' },
]
const row = (
  categoryId: string | null,
  kind: SplitSumRow['kind'],
  cents: number,
  count = 1,
): SplitSumRow => ({ categoryId, kind, month: null, cents, inCents: Math.max(cents, 0), count })
const rows = [
  row('sales', 'income', 500000),
  row('rent', 'expense', -120000),
  row('meals', 'expense', -10001),
  row('ads', 'expense', -3000),
  row('misc', 'expense', 500), // a refund bigger than the spending
  row(null, null, -4200, 3),
]
const range = { from: '2030-01-01', to: '2030-12-31' }

describe('profitAndLoss', () => {
  /**
   * Function: profitAndLoss
   * Inputs:   $5,000 sales; rent, meals and advertising spending; a $5 net refund in Misc; three
   *           uncategorized splits netting -$42
   * Expected: spending shown as positive (the refund negative); totals add the categorized lines
   *           only; uncategorized reported separately with its count; lines sorted by name
   */
  it('totals income and spending, and keeps uncategorized money out', () => {
    const pl = profitAndLoss(rows, categories, range)
    expect(pl.income.map((l) => [l.name, l.cents])).toEqual([['Sales', 500000]])
    expect(pl.expenses.map((l) => [l.name, l.cents])).toEqual([
      ['Advertising', 3000],
      ['Meals', 10001],
      ['Misc', -500],
      ['Rent', 120000],
    ])
    expect(pl.totals).toEqual({ incomeCents: 500000, expenseCents: 132501, netCents: 367499 })
    expect(pl.uncategorized).toEqual({ count: 3, netCents: -4200 })
  })

  /**
   * Function: profitAndLoss
   * Inputs:   a transfer-kind row, and a row for a category that no longer exists
   * Expected: the transfer is ignored; the unknown category is counted as uncategorized, not lost
   */
  it('never counts transfers and never silently drops money', () => {
    const pl = profitAndLoss(
      [row('x', 'transfer', 100), row('gone', 'expense', -700)],
      [...categories, { id: 'x', name: 'Transfer', taxLine: null }],
      range,
    )
    expect(pl.totals.netCents).toBe(0)
    expect(pl.uncategorized).toEqual({ count: 1, netCents: -700 })
  })
})

describe('taxSummary', () => {
  /**
   * Function: countedCents
   * Inputs:   50% of 10001, of -10001, of 1; 0%; 33% of 1000; no percent
   * Expected: 5001, -5001, 1 (halves round away from zero), 0, 330, unchanged
   */
  it('counts part of an amount to the nearest cent', () => {
    expect(countedCents(10001, 50)).toBe(5001)
    expect(countedCents(-10001, 50)).toBe(-5001)
    expect(countedCents(1, 50)).toBe(1)
    expect(countedCents(999, 0)).toBe(0)
    expect(countedCents(1000, 33)).toBe(330)
    expect(countedCents(1234, null)).toBe(1234)
  })

  /**
   * Function: taxSummary
   * Inputs:   the rows above with Meals counted at 50%
   * Expected: expense groups in tax line order (8, 20, 24b) with "No tax line" last (a blank line
   *           counts as none); Meals spent 10001, counted 5001; counted expenses lower than spent
   *           by 5000; net stays the real profit
   */
  it('groups by tax line and applies partly counted categories', () => {
    const s = taxSummary(profitAndLoss(rows, categories, range), 2030, new Map([['meals', 50]]))
    expect(s.expenses.map((g) => g.taxLine)).toEqual(['Line 8', 'Line 20', 'Line 24b', null])
    expect(s.expenses[2]).toMatchObject({ totalCents: 10001, countedCents: 5001 })
    expect(s.income.map((g) => g.taxLine)).toEqual([null])
    expect(s.totals).toEqual({
      incomeCents: 500000,
      expenseCents: 132501,
      countedExpenseCents: 127501,
      netCents: 367499,
    })
  })
})

describe('maskTaxId', () => {
  /**
   * Function: maskTaxId
   * Inputs:   made-up IDs "000-00-6789", "AB 123456 C", "12345"
   * Expected: only the last four letters or numbers show; a very short ID shows none
   */
  it('shows at most the last four characters', () => {
    expect(maskTaxId('000-00-6789')).toBe('•••••6789')
    expect(maskTaxId('AB 123456 C')).toBe('•••••456C')
    expect(maskTaxId('12345')).toBe('•••••')
  })
})

describe('csvText', () => {
  /**
   * Function: csvText
   * Inputs:   cells starting with = + - @ and a tab; a comma, quotes and a line break; plain text
   * Expected: formula-like cells get a leading apostrophe; special characters are quoted
   */
  it('stops formulas and quotes special characters', () => {
    for (const bad of ['=HYPERLINK("x")', '+1', '-2', '@SUM(A1)', '\tx'])
      expect(csvText(bad).replace(/^"/, '').startsWith("'"), bad).toBe(true)
    expect(csvText('Smith, Jones')).toBe('"Smith, Jones"')
    expect(csvText('a "b"')).toBe('"a ""b"""')
    expect(csvText('two\nlines')).toBe('"two\nlines"')
    expect(csvText('Coffee')).toBe('Coffee')
  })
})
