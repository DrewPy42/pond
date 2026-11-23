import type { RuleAction, RuleCondition } from '@pond/shared'
import { describe, expect, it } from 'vitest'
import {
  conditionMatches,
  evaluateRules,
  globMatches,
  ruleMatches,
  type RuleInput,
  type RuleLike,
} from './engine'

// Pure rules engine: plain objects in, a decision out. No repositories.

const tx = (over: Partial<RuleInput> = {}): RuleInput => ({
  descriptionRaw: 'CORNER MARKET #12 SEATTLE WA',
  payee: null,
  amountCents: -4250,
  accountId: 'acct-1',
  ...over,
})
const text = (
  op: 'contains' | 'starts_with' | 'equals' | 'matches',
  value: string,
  field: 'description' | 'payee' | 'any' = 'description',
): RuleCondition => ({ type: 'text', field, op, value })
const rule = (
  id: string,
  priority: number,
  conditions: RuleCondition[],
  actions: RuleAction[],
  enabled = true,
): RuleLike => ({ id, priority, enabled, conditions, actions })

describe('globMatches(pattern, text)', () => {
  /**
   * Inputs:   "corner*" vs "CORNER MARKET"; "*market*" vs "Corner Market #12"; "c?rner" vs "corner";
   *           "*" vs ""; "a*c" vs "abc"; "a*c" vs "abd"
   * Expected: true, true, true, true, true, false (case-insensitive; * any run, ? one character)
   */
  it('matches wildcards case-insensitively', () => {
    expect(globMatches('corner*', 'CORNER MARKET')).toBe(true)
    expect(globMatches('*market*', 'Corner Market #12')).toBe(true)
    expect(globMatches('c?rner', 'corner')).toBe(true)
    expect(globMatches('*', '')).toBe(true)
    expect(globMatches('a*c', 'abc')).toBe(true)
    expect(globMatches('a*c', 'abd')).toBe(false)
  })
  /**
   * Inputs:   "market" vs "corner market" (no wildcards); "?" vs ""; "ab" vs "a"
   * Expected: false (whole-text match); false; false
   */
  it('must match the whole text unless wildcards say otherwise', () => {
    expect(globMatches('market', 'corner market')).toBe(false)
    expect(globMatches('?', '')).toBe(false)
    expect(globMatches('ab', 'a')).toBe(false)
  })
  /**
   * Inputs:   the classic catastrophic pattern "a*a*a*a*a*a*a*a*b" against 20,000 letter a's
   * Expected: false, and it finishes quickly (a regex engine could take forever; this never does)
   */
  it('cannot be made to run for exponential time', () => {
    const started = Date.now()
    expect(globMatches('a*a*a*a*a*a*a*a*b', 'a'.repeat(20_000))).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('conditionMatches(condition, transaction)', () => {
  /**
   * Inputs:   text conditions on description "CORNER MARKET #12 SEATTLE WA": contains "market",
   *           starts_with "corner", equals "corner market" (not whole), matches "*seattle*"
   * Expected: true, true, false, true
   */
  it('matches text with contains, starts_with, equals and matches', () => {
    expect(conditionMatches(text('contains', 'market'), tx())).toBe(true)
    expect(conditionMatches(text('starts_with', 'corner'), tx())).toBe(true)
    expect(conditionMatches(text('equals', 'corner market'), tx())).toBe(false)
    expect(conditionMatches(text('matches', '*seattle*'), tx())).toBe(true)
  })
  /**
   * Inputs:   field "payee" with payee null and then "Cafe"; field "any" for a word only in the payee
   * Expected: payee null never matches; "Cafe" matches; "any" looks at description and payee
   */
  it('looks at the chosen field: description, payee, or either', () => {
    expect(conditionMatches(text('contains', 'cafe', 'payee'), tx())).toBe(false)
    expect(conditionMatches(text('contains', 'cafe', 'payee'), tx({ payee: 'Cafe' }))).toBe(true)
    expect(conditionMatches(text('contains', 'cafe', 'any'), tx({ payee: 'Cafe' }))).toBe(true)
    expect(conditionMatches(text('contains', 'market', 'any'), tx({ payee: 'Cafe' }))).toBe(true)
  })
  /**
   * Inputs:   amount -4250 against ranges 40.00-50.00, min 50.00, max 40.00 and min only 42.50
   * Expected: true, false, false, true (sign is ignored; both ends inclusive)
   */
  it('compares the size of the amount, ignoring sign, inclusive at both ends', () => {
    const amt = (minCents?: number, maxCents?: number): RuleCondition => ({
      type: 'amount',
      minCents,
      maxCents,
    })
    expect(conditionMatches(amt(4000, 5000), tx())).toBe(true)
    expect(conditionMatches(amt(5000), tx())).toBe(false)
    expect(conditionMatches(amt(undefined, 4000), tx())).toBe(false)
    expect(conditionMatches(amt(4250), tx())).toBe(true)
    expect(conditionMatches(amt(4000, 5000), tx({ amountCents: 4250 }))).toBe(true)
  })
  /**
   * Inputs:   account condition for acct-1 and acct-2; direction "out" and "in" on -4250 and +100
   * Expected: true / false; out matches -4250 only, in matches +100 only
   */
  it('matches a specific account and the direction of the money', () => {
    expect(conditionMatches({ type: 'account', accountId: 'acct-1' }, tx())).toBe(true)
    expect(conditionMatches({ type: 'account', accountId: 'acct-2' }, tx())).toBe(false)
    expect(conditionMatches({ type: 'direction', direction: 'out' }, tx())).toBe(true)
    expect(conditionMatches({ type: 'direction', direction: 'in' }, tx())).toBe(false)
    expect(conditionMatches({ type: 'direction', direction: 'in' }, tx({ amountCents: 100 }))).toBe(
      true,
    )
  })
})

describe('ruleMatches(rule, transaction)', () => {
  /**
   * Inputs:   a rule with two conditions (contains "market" AND direction "out"); the same with the
   *           second changed to "in"; and a rule with no conditions
   * Expected: true; false (every condition must hold); false (an empty rule never matches everything)
   */
  it('needs every condition, and never matches with none', () => {
    expect(
      ruleMatches(
        { conditions: [text('contains', 'market'), { type: 'direction', direction: 'out' }] },
        tx(),
      ),
    ).toBe(true)
    expect(
      ruleMatches(
        { conditions: [text('contains', 'market'), { type: 'direction', direction: 'in' }] },
        tx(),
      ),
    ).toBe(false)
    expect(ruleMatches({ conditions: [] }, tx())).toBe(false)
  })
})

describe('evaluateRules(rules, transaction)', () => {
  const market = text('contains', 'market')

  /**
   * Inputs:   rules A (priority 20, sets category "c-a" and payee "A") and B (priority 10, sets category
   *           "c-b" and payee "B"), both matching
   * Expected: B runs first so its category and payee win; both rules are listed as matched in the
   *           order they ran; "from" records B as the source
   */
  it('runs rules lowest priority number first and lets the first rule win each change', () => {
    const out = evaluateRules(
      [
        rule(
          'A',
          20,
          [market],
          [
            { type: 'set_category', categoryId: 'c-a' },
            { type: 'set_payee', payee: 'A' },
          ],
        ),
        rule(
          'B',
          10,
          [market],
          [
            { type: 'set_category', categoryId: 'c-b' },
            { type: 'set_payee', payee: 'B' },
          ],
        ),
      ],
      tx(),
    )
    expect(out).toMatchObject({
      categoryId: 'c-b',
      payee: 'B',
      matched: ['B', 'A'],
      from: { categoryId: 'B', payee: 'B' },
    })
  })
  /**
   * Inputs:   rule B sets only a category; rule A (lower priority) sets only a payee
   * Expected: both apply: a later rule still adds changes an earlier one didn't make
   */
  it('combines different changes from different rules', () => {
    const out = evaluateRules(
      [
        rule('B', 10, [market], [{ type: 'set_category', categoryId: 'c' }]),
        rule('A', 20, [market], [{ type: 'set_payee', payee: 'Market' }]),
      ],
      tx(),
    )
    expect(out).toMatchObject({ categoryId: 'c', payee: 'Market' })
  })
  /**
   * Inputs:   a disabled matching rule; a matching rule with other conditions failing
   * Expected: neither contributes anything
   */
  it('ignores disabled rules and rules whose conditions fail', () => {
    const out = evaluateRules(
      [
        rule('off', 1, [market], [{ type: 'set_payee', payee: 'X' }], false),
        rule('no', 2, [text('contains', 'zzz')], [{ type: 'set_payee', payee: 'Y' }]),
      ],
      tx(),
    )
    expect(out).toEqual({ matched: [], from: {} })
  })
  /**
   * Inputs:   two rules with the same priority, ids "b" and "a"
   * Expected: ties run in id order (a first), so results are repeatable
   */
  it('breaks priority ties by id', () => {
    const out = evaluateRules(
      [
        rule('b', 5, [market], [{ type: 'set_payee', payee: 'from b' }]),
        rule('a', 5, [market], [{ type: 'set_payee', payee: 'from a' }]),
      ],
      tx(),
    )
    expect(out.payee).toBe('from a')
  })
  /**
   * Inputs:   a rule with move_to_space, mark_reimbursable and link_transfer actions
   * Expected: spaceId, reimbursable and linkTransfer set on the outcome
   */
  it('reports space moves, reimbursable marks and transfer links', () => {
    const out = evaluateRules(
      [
        rule(
          'r',
          1,
          [market],
          [
            { type: 'move_to_space', spaceId: 'biz' },
            { type: 'mark_reimbursable' },
            { type: 'link_transfer' },
          ],
        ),
      ],
      tx(),
    )
    expect(out).toMatchObject({
      spaceId: 'biz',
      reimbursable: true,
      linkTransfer: true,
      from: { spaceId: 'r', linkTransfer: 'r' },
    })
  })
})
