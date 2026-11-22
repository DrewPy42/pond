import { describe, expect, it } from 'vitest'
import {
  centsSchema,
  createAccountSchema,
  createTransactionSchema,
  isoDateSchema,
  updateTransactionSchema,
} from './ledger'

describe('isoDateSchema', () => {
  /**
   * Inputs:   "2030-02-28", "2028-02-29" (leap day)
   * Expected: both accepted
   */
  it('accepts real calendar days', () => {
    expect(isoDateSchema.safeParse('2030-02-28').success).toBe(true)
    expect(isoDateSchema.safeParse('2028-02-29').success).toBe(true)
  })
  /**
   * Inputs:   "2030-02-30", "2029-02-29", "2030-13-01", "2030-1-5", "tomorrow"
   * Expected: all rejected (impossible dates and wrong formats)
   */
  it('rejects impossible dates and other formats', () => {
    for (const bad of ['2030-02-30', '2029-02-29', '2030-13-01', '2030-1-5', 'tomorrow']) {
      expect(isoDateSchema.safeParse(bad).success, bad).toBe(false)
    }
  })
})

describe('centsSchema', () => {
  /**
   * Inputs:   -1250, 0, 99
   * Expected: accepted (whole cents, any sign)
   */
  it('accepts whole cents', () => {
    for (const n of [-1250, 0, 99]) expect(centsSchema.safeParse(n).success).toBe(true)
  })
  /**
   * Inputs:   12.5, NaN, 1e13 (beyond the safe range), "100" (a string)
   * Expected: all rejected (CLAUDE.md rule 2: integer cents only)
   */
  it('rejects fractions, NaN, huge values and strings', () => {
    for (const bad of [12.5, Number.NaN, 1e13, '100'])
      expect(centsSchema.safeParse(bad).success, String(bad)).toBe(false)
  })
})

describe('createTransactionSchema / updateTransactionSchema', () => {
  const ok = { accountId: 'a', date: '2030-01-10', amountCents: -1000, description: 'Lunch' }
  /**
   * Inputs:   a minimal valid transaction; one with zero amount; one with an empty description
   * Expected: valid; rejected (amount can't be zero); rejected
   */
  it('requires a non-zero amount and a description', () => {
    expect(createTransactionSchema.safeParse(ok).success).toBe(true)
    expect(createTransactionSchema.safeParse({ ...ok, amountCents: 0 }).success).toBe(false)
    expect(createTransactionSchema.safeParse({ ...ok, description: '  ' }).success).toBe(false)
  })
  /**
   * Inputs:   an empty update {}; an update that only changes the payee
   * Expected: rejected ("nothing to update"); accepted
   */
  it('refuses an empty update', () => {
    expect(updateTransactionSchema.safeParse({}).success).toBe(false)
    expect(updateTransactionSchema.safeParse({ payee: 'Acme' }).success).toBe(true)
  })
})

describe('createAccountSchema', () => {
  /**
   * Inputs:   name + type only; lastFour "12a4"; an unknown type
   * Expected: accepted with includeInNetWorth defaulting to true; rejected; rejected
   */
  it('validates type and last four, and defaults net-worth inclusion', () => {
    const r = createAccountSchema.safeParse({ name: 'Checking', type: 'checking' })
    expect(r.success && r.data.includeInNetWorth).toBe(true)
    expect(
      createAccountSchema.safeParse({ name: 'X', type: 'checking', lastFour: '12a4' }).success,
    ).toBe(false)
    expect(createAccountSchema.safeParse({ name: 'X', type: 'nope' }).success).toBe(false)
  })
})
