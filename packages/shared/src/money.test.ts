import { describe, expect, it } from 'vitest'
import { allocateCents, formatCents, parseCents, splitsBalance, sumCents } from './money'

describe('money', () => {
  it('parses common formats', () => {
    expect(parseCents('12.34')).toBe(1234)
    expect(parseCents('-12.3')).toBe(-1230)
    expect(parseCents('$1,234.50')).toBe(123450)
    expect(parseCents('(5.00)')).toBe(-500)
    expect(parseCents('7')).toBe(700)
  })
  it('rejects garbage and sub-cent precision', () => {
    expect(() => parseCents('abc')).toThrow()
    expect(() => parseCents('1.234')).toThrow()
    expect(() => parseCents('')).toThrow()
  })
  it('formats', () => {
    expect(formatCents(-1234)).toBe('-12.34')
    expect(formatCents(5)).toBe('0.05')
  })
  it('rejects non-integer cents', () => {
    expect(() => sumCents([1.5])).toThrow()
  })
  it('checks the split invariant', () => {
    expect(splitsBalance(1000, [600, 400])).toBe(true)
    expect(splitsBalance(1000, [600, 399])).toBe(false)
    expect(splitsBalance(1000, [])).toBe(false)
  })
  it('allocates without losing cents', () => {
    expect(allocateCents(100, 3)).toEqual([34, 33, 33])
    expect(allocateCents(-100, 3)).toEqual([-34, -33, -33])
    expect(sumCents(allocateCents(1, 7))).toBe(1)
  })
})
