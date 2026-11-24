import { describe, expect, it } from 'vitest'
import {
  addMonths,
  amountForMonth,
  currentMonth,
  isRealDate,
  monthBounds,
  monthlyNeededCents,
  percentSaved,
  suggestCents,
} from './logic'

describe('months and dates', () => {
  /**
   * Function: addMonths
   * Inputs:   2030-11 +1, 2030-12 +1, 2030-01 -1, 2030-03 -15
   * Expected: 2030-12, 2031-01, 2029-12, 2028-12 (years roll over both ways)
   */
  it('moves across year ends', () => {
    expect(addMonths('2030-11', 1)).toBe('2030-12')
    expect(addMonths('2030-12', 1)).toBe('2031-01')
    expect(addMonths('2030-01', -1)).toBe('2029-12')
    expect(addMonths('2030-03', -15)).toBe('2028-12')
  })

  /**
   * Function: monthBounds
   * Inputs:   2030-02 (not a leap year), 2032-02 (leap year), 2030-12
   * Expected: last days 28, 29, 31
   */
  it('finds the first and last day of a month', () => {
    expect(monthBounds('2030-02')).toEqual({ from: '2030-02-01', to: '2030-02-28' })
    expect(monthBounds('2032-02').to).toBe('2032-02-29')
    expect(monthBounds('2030-12').to).toBe('2030-12-31')
  })

  /**
   * Function: isRealDate
   * Inputs:   2030-02-28, 2030-02-30, 2030-13-01, "tomorrow"
   * Expected: only the first is a real date
   */
  it('rejects dates that are not on the calendar', () => {
    expect(isRealDate('2030-02-28')).toBe(true)
    expect(isRealDate('2030-02-30')).toBe(false)
    expect(isRealDate('2030-13-01')).toBe(false)
    expect(isRealDate('tomorrow')).toBe(false)
  })

  /**
   * Function: currentMonth
   * Inputs:   a local date of 5 March 2030
   * Expected: "2030-03" (zero padded)
   */
  it('writes the current month as YYYY-MM', () => {
    expect(currentMonth(new Date(2030, 2, 5))).toBe('2030-03')
  })
})

describe('amountForMonth (budgets carry forward)', () => {
  const rows = [
    { month: '2030-01', amountCents: 40000 },
    { month: '2030-04', amountCents: 50000 },
    { month: '2030-07', amountCents: 0 },
  ]
  /**
   * Function: amountForMonth
   * Inputs:   rows effective from Jan (400), Apr (500) and Jul (0 = stop); months Dec 2029 to Aug 2030
   * Expected: not tracked before Jan; 400 Jan to Mar; 500 Apr to Jun; not tracked from Jul on
   */
  it('uses the latest row at or before the month, and 0 means stop', () => {
    expect(amountForMonth(rows, '2029-12')).toBeNull()
    expect(amountForMonth(rows, '2030-01')).toBe(40000)
    expect(amountForMonth(rows, '2030-03')).toBe(40000)
    expect(amountForMonth(rows, '2030-04')).toBe(50000)
    expect(amountForMonth(rows, '2030-06')).toBe(50000)
    expect(amountForMonth(rows, '2030-07')).toBeNull()
    expect(amountForMonth(rows, '2030-08')).toBeNull()
  })
})

describe('suggestCents', () => {
  /**
   * Function: suggestCents
   * Inputs:   three-month totals of $0, -$5, $450.00, $448.49, $448.50, $1,000.00
   * Expected: nothing for zero/negative; the monthly average to the nearest whole dollar
   *           (450 -> 150.00; 448.49 -> 149.00; 448.50 -> 150.00; 1000 -> 333.00)
   */
  it('averages three months to a whole dollar', () => {
    expect(suggestCents(0)).toBe(0)
    expect(suggestCents(-500)).toBe(0)
    expect(suggestCents(45000)).toBe(15000)
    expect(suggestCents(44849)).toBe(14900)
    expect(suggestCents(44850)).toBe(15000)
    expect(suggestCents(100000)).toBe(33300)
  })
})

describe('goals', () => {
  /**
   * Function: percentSaved
   * Inputs:   saved 250 of 1000; saved 5000 of 1000; negative saved; zero target
   * Expected: 25; capped at 100; 0; 0
   */
  it('gives a whole percent from 0 to 100', () => {
    expect(percentSaved(250, 1000)).toBe(25)
    expect(percentSaved(5000, 1000)).toBe(100)
    expect(percentSaved(-10, 1000)).toBe(0)
    expect(percentSaved(10, 0)).toBe(0)
  })

  /**
   * Function: monthlyNeededCents
   * Inputs:   $1,200 target, $0 saved, today 2030-01-15, target date 2030-12-31 (12 months counting this one);
   *           then saved $300 (so $900 left); a target this month; a date that has passed; no date; goal met
   * Expected: $100.00/month; $75.00/month; the whole $900 left this month; null; null; 0
   */
  it('works out about how much to save each month', () => {
    expect(monthlyNeededCents(120000, 0, '2030-12-31', '2030-01-15')).toBe(10000)
    expect(monthlyNeededCents(120000, 30000, '2030-12-31', '2030-01-15')).toBe(7500)
    expect(monthlyNeededCents(120000, 30000, '2030-01-31', '2030-01-15')).toBe(90000)
    expect(monthlyNeededCents(120000, 0, '2029-12-31', '2030-01-15')).toBeNull()
    expect(monthlyNeededCents(120000, 0, null, '2030-01-15')).toBeNull()
    expect(monthlyNeededCents(120000, 120000, '2030-12-31', '2030-01-15')).toBe(0)
  })

  /**
   * Function: monthlyNeededCents (rounding)
   * Inputs:   $1,000.00 over 3 months
   * Expected: rounded up to 33334 cents so the goal is never short
   */
  it('rounds up to the next cent', () => {
    expect(monthlyNeededCents(100000, 0, '2030-03-31', '2030-01-10')).toBe(33334)
  })
})
