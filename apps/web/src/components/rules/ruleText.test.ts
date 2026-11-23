import { describe, expect, it } from 'vitest'
import { actionText, conditionText, type Lookups } from './ruleText'

const l: Lookups = {
  accounts: new Map([['a1', 'Checking']]),
  categories: new Map([['c1', 'Groceries']]),
  spaces: new Map([['s1', 'WibbitWorks']]),
}

describe('conditionText(condition, lookups)', () => {
  /**
   * Inputs:   a text condition (description contains "market"), a payee equals condition, an amount
   *           range 40.00-50.00, min only, an account, and both directions
   * Expected: readable sentences, with money formatted ("$40.00") and the account named
   */
  it('describes each kind of condition in plain words', () => {
    expect(
      conditionText({ type: 'text', field: 'description', op: 'contains', value: 'market' }, l),
    ).toBe('The description contains "market"')
    expect(conditionText({ type: 'text', field: 'payee', op: 'equals', value: 'Acme' }, l)).toBe(
      'The payee is exactly "Acme"',
    )
    expect(conditionText({ type: 'amount', minCents: 4000, maxCents: 5000 }, l)).toBe(
      'The amount is between $40.00 and $50.00',
    )
    expect(conditionText({ type: 'amount', minCents: 4000 }, l)).toBe(
      'The amount is at least $40.00',
    )
    expect(conditionText({ type: 'account', accountId: 'a1' }, l)).toBe('The account is Checking')
    expect(conditionText({ type: 'direction', direction: 'in' }, l)).toBe('Money comes in')
    expect(conditionText({ type: 'direction', direction: 'out' }, l)).toBe('Money goes out')
  })
})

describe('actionText(action, lookups)', () => {
  /**
   * Inputs:   one of each action, plus a category id that no longer exists
   * Expected: readable sentences; the missing category reads "unknown" instead of breaking
   */
  it('describes each kind of action in plain words', () => {
    expect(actionText({ type: 'set_payee', payee: 'Corner Market' }, l)).toBe(
      'Set the payee to "Corner Market"',
    )
    expect(actionText({ type: 'set_category', categoryId: 'c1' }, l)).toBe(
      'Set the category to Groceries',
    )
    expect(actionText({ type: 'set_category', categoryId: 'gone' }, l)).toBe(
      'Set the category to unknown',
    )
    expect(actionText({ type: 'move_to_space', spaceId: 's1' }, l)).toBe(
      'Move to the WibbitWorks Space',
    )
    expect(actionText({ type: 'mark_reimbursable' }, l)).toBe('Mark as reimbursable')
    expect(actionText({ type: 'link_transfer' }, l)).toContain('transfer')
  })
})
