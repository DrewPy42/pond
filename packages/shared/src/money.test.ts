import { describe, expect, it } from 'vitest'
import {
  allocateCents,
  assertCents,
  formatCents,
  formatMoney,
  parseCents,
  splitsBalance,
  sumCents,
} from './money'

// Money is signed integer cents; positive = money into the account (CLAUDE.md rules 2 and 3).

describe('parseCents(input)', () => {
  /**
   * Inputs:   "12.34", "-12.3", "$1,234.50", "(5.00)", "7"
   * Expected: 1234, -1230, 123450, -500, 700 (dollar signs and commas ignored, parentheses mean
   *           negative, a missing or short decimal part is padded)
   */
  it('turns common money formats into integer cents', () => {
    expect(parseCents('12.34')).toBe(1234)
    expect(parseCents('-12.3')).toBe(-1230)
    expect(parseCents('$1,234.50')).toBe(123450)
    expect(parseCents('(5.00)')).toBe(-500)
    expect(parseCents('7')).toBe(700)
  })

  /**
   * Inputs:   "abc", "1.234" (a fraction of a cent), "" (empty)
   * Expected: throws RangeError for each. We never round silently; bad data must be seen.
   */
  it('rejects text that is not money, including sub-cent precision', () => {
    expect(() => parseCents('abc')).toThrow(RangeError)
    expect(() => parseCents('1.234')).toThrow(RangeError)
    expect(() => parseCents('')).toThrow(RangeError)
  })
})

describe('formatCents(cents)', () => {
  /**
   * Inputs:   -1234 and 5
   * Expected: "-12.34" and "0.05" (always two decimals, minus sign for money out)
   */
  it('prints cents as a plain decimal string', () => {
    expect(formatCents(-1234)).toBe('-12.34')
    expect(formatCents(5)).toBe('0.05')
  })
})

describe('sumCents(values) and assertCents(value)', () => {
  /**
   * Inputs:   [1.5] (a float, not whole cents)
   * Expected: throws RangeError. Floats must never enter ledger math.
   */
  it('refuses non-integer amounts', () => {
    expect(() => sumCents([1.5])).toThrow(RangeError)
    expect(() => assertCents(0.1 + 0.2)).toThrow(RangeError)
  })

  /**
   * Inputs:   [100, -250, 5]
   * Expected: -145 (exact integer addition)
   */
  it('adds whole cents exactly', () => {
    expect(sumCents([100, -250, 5])).toBe(-145)
  })
})

describe('splitsBalance(txnCents, splitCents)', () => {
  /**
   * Inputs:   a 1000-cent transaction with splits [600, 400]
   * Expected: true (splits add up exactly to the transaction)
   */
  it('is true when the splits add up to the transaction amount', () => {
    expect(splitsBalance(1000, [600, 400])).toBe(true)
  })

  /**
   * Inputs:   a 1000-cent transaction with splits [600, 399] (one cent short)
   * Expected: false. This is the invariant from data-model.md; a write like this must be refused.
   */
  it('is false when the splits are off by even one cent', () => {
    expect(splitsBalance(1000, [600, 399])).toBe(false)
  })

  /**
   * Inputs:   a 1000-cent transaction with no splits ([])
   * Expected: false. Every transaction has at least one split.
   */
  it('is false when there are no splits at all', () => {
    expect(splitsBalance(1000, [])).toBe(false)
  })
})

describe('allocateCents(total, parts)', () => {
  /**
   * Inputs:   total 100 split into 3 parts; total -100 split into 3 parts
   * Expected: [34, 33, 33] and [-34, -33, -33]. The leftover cent goes to the first share, and
   *           the sign is preserved.
   */
  it('divides a total into shares, giving remainder cents to the earliest shares', () => {
    expect(allocateCents(100, 3)).toEqual([34, 33, 33])
    expect(allocateCents(-100, 3)).toEqual([-34, -33, -33])
  })

  /**
   * Inputs:   total 1 split into 7 parts
   * Expected: the shares still sum to exactly 1 (no cent is created or lost)
   */
  it('never loses or creates cents', () => {
    expect(sumCents(allocateCents(1, 7))).toBe(1)
  })
})

describe('formatMoney(cents, currency)', () => {
  /**
   * Inputs:   123456 (USD), -500 (USD), 99 (EUR), 0, 100000000 (a million dollars)
   * Expected: "$1,234.56", "-$5.00", "€0.99", "$0.00", "$1,000,000.00"
   */
  it('formats cents with a symbol, thousands separators and a leading minus', () => {
    expect(formatMoney(123456)).toBe('$1,234.56')
    expect(formatMoney(-500)).toBe('-$5.00')
    expect(formatMoney(99, 'EUR')).toBe('€0.99')
    expect(formatMoney(0)).toBe('$0.00')
    expect(formatMoney(100000000)).toBe('$1,000,000.00')
  })

  /**
   * Inputs:   1250 in "CHF" (no symbol on file)
   * Expected: "CHF 12.50" (the currency code is shown instead of guessing a symbol)
   */
  it('falls back to the currency code for unknown currencies', () => {
    expect(formatMoney(1250, 'CHF')).toBe('CHF 12.50')
  })
})
