import { describe, expect, it } from 'vitest'
import { columnMapSchema, commitImportSchema } from './imports'
import { actionSchema, conditionSchema, createRuleSchema, updateRuleSchema } from './rules'

const text = { type: 'text', field: 'description', op: 'contains', value: 'market' }

describe('conditionSchema and actionSchema', () => {
  /**
   * Inputs:   a text, an amount (min only), an account and a direction condition
   * Expected: all accepted
   */
  it('accepts every condition kind', () => {
    for (const c of [
      text,
      { type: 'amount', minCents: 100 },
      { type: 'account', accountId: 'a' },
      { type: 'direction', direction: 'in' },
    ]) {
      expect(conditionSchema.safeParse(c).success, JSON.stringify(c)).toBe(true)
    }
  })
  /**
   * Inputs:   an amount condition with neither bound; min greater than max; negative min; a text value
   *           that is only spaces; a regex-style op; a 201-character value
   * Expected: all rejected (the rule engine never sees a regular expression)
   */
  it('rejects empty, inverted, negative and over-long conditions, and regex operators', () => {
    for (const c of [
      { type: 'amount' },
      { type: 'amount', minCents: 500, maxCents: 100 },
      { type: 'amount', minCents: -1 },
      { ...text, value: '   ' },
      { ...text, op: 'regex' },
      { ...text, value: 'x'.repeat(201) },
    ]) {
      expect(conditionSchema.safeParse(c).success, JSON.stringify(c)).toBe(false)
    }
  })
  /**
   * Inputs:   each action kind; and an unknown action
   * Expected: the five known kinds accepted; the unknown one rejected
   */
  it('accepts the five actions and nothing else', () => {
    for (const a of [
      { type: 'set_payee', payee: 'X' },
      { type: 'set_category', categoryId: 'c' },
      { type: 'move_to_space', spaceId: 's' },
      { type: 'mark_reimbursable' },
      { type: 'link_transfer' },
    ]) {
      expect(actionSchema.safeParse(a).success, a.type).toBe(true)
    }
    expect(actionSchema.safeParse({ type: 'delete_everything' }).success).toBe(false)
  })
})

describe('createRuleSchema and updateRuleSchema', () => {
  const ok = { name: 'Market', conditions: [text], actions: [{ type: 'mark_reimbursable' }] }
  /**
   * Inputs:   a minimal rule; one with no conditions; one with no actions; an empty update
   * Expected: accepted with priority 100 and enabled true by default; rejected; rejected; rejected
   */
  it('needs a name, a condition and an action, with sensible defaults', () => {
    const r = createRuleSchema.safeParse(ok)
    expect(r.success && [r.data.priority, r.data.enabled]).toEqual([100, true])
    expect(createRuleSchema.safeParse({ ...ok, conditions: [] }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...ok, actions: [] }).success).toBe(false)
    expect(updateRuleSchema.safeParse({}).success).toBe(false)
    expect(updateRuleSchema.safeParse({ enabled: false }).success).toBe(true)
  })
})

describe('columnMapSchema and commitImportSchema', () => {
  const map = {
    hasHeader: true,
    dateColumn: 0,
    dateFormat: 'YYYY-MM-DD',
    descriptionColumn: 1,
    amount: { mode: 'single', column: 2 },
  }
  /**
   * Inputs:   a single-column and a split-column mapping; an unknown date format; a column of 99
   * Expected: both mappings accepted (invert defaults to false); the last two rejected
   */
  it('validates column mappings', () => {
    const single = columnMapSchema.safeParse(map)
    expect(single.success && single.data.amount).toEqual({
      mode: 'single',
      column: 2,
      invert: false,
    })
    expect(
      columnMapSchema.safeParse({
        ...map,
        amount: { mode: 'split', debitColumn: 2, creditColumn: 3 },
      }).success,
    ).toBe(true)
    expect(columnMapSchema.safeParse({ ...map, dateFormat: 'DD.MM.YYYY' }).success).toBe(false)
    expect(columnMapSchema.safeParse({ ...map, dateColumn: 99 }).success).toBe(false)
  })
  /**
   * Inputs:   a commit with only the required fields; one with an empty file; one over 6 MB
   * Expected: accepted with empty skip and include lists; rejected; rejected
   */
  it('validates an import commit and its size limit', () => {
    const base = { accountId: 'a', filename: 'jan.csv', csv: 'x', mapping: map }
    const r = commitImportSchema.safeParse(base)
    expect(r.success && [r.data.skipRows, r.data.includeDuplicateRows]).toEqual([[], []])
    expect(commitImportSchema.safeParse({ ...base, csv: '' }).success).toBe(false)
    expect(commitImportSchema.safeParse({ ...base, csv: 'x'.repeat(6_000_001) }).success).toBe(
      false,
    )
  })
})
