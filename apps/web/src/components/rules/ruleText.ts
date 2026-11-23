import type { RuleAction, RuleCondition } from '@pond/shared'
import { formatMoney } from '@pond/shared'

/** Plain-language descriptions of rule conditions and actions, used by the Rules page and the editor. */
export interface Lookups {
  accounts: Map<string, string>
  categories: Map<string, string>
  spaces: Map<string, string>
}

const OPS: Record<string, string> = {
  contains: 'contains',
  starts_with: 'starts with',
  equals: 'is exactly',
  matches: 'matches',
}
const FIELDS: Record<string, string> = {
  description: 'The description',
  payee: 'The payee',
  any: 'The description or payee',
}

export function conditionText(c: RuleCondition, l: Lookups): string {
  switch (c.type) {
    case 'text':
      return `${FIELDS[c.field]} ${OPS[c.op]} "${c.value}"`
    case 'amount': {
      const min = c.minCents !== undefined ? formatMoney(c.minCents) : null
      const max = c.maxCents !== undefined ? formatMoney(c.maxCents) : null
      if (min && max) return `The amount is between ${min} and ${max}`
      return min ? `The amount is at least ${min}` : `The amount is at most ${max}`
    }
    case 'account':
      return `The account is ${l.accounts.get(c.accountId) ?? 'unknown'}`
    case 'direction':
      return c.direction === 'in' ? 'Money comes in' : 'Money goes out'
  }
}

export function actionText(a: RuleAction, l: Lookups): string {
  switch (a.type) {
    case 'set_payee':
      return `Set the payee to "${a.payee}"`
    case 'set_category':
      return `Set the category to ${l.categories.get(a.categoryId) ?? 'unknown'}`
    case 'move_to_space':
      return `Move to the ${l.spaces.get(a.spaceId) ?? 'unknown'} Space`
    case 'mark_reimbursable':
      return 'Mark as reimbursable'
    case 'link_transfer':
      return 'Link as a transfer when the other half is found'
  }
}
