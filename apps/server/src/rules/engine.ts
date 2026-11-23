import type { RuleAction, RuleCondition } from '@pond/shared'

/**
 * The rules engine: pure functions, no database. Given a transaction's facts and the Space's
 * rules, say what should change. Applying that (checking categories and permissions, writing
 * through repositories) is rules/service.ts.
 */

export interface RuleInput {
  descriptionRaw: string
  payee: string | null
  amountCents: number
  accountId: string
}

export interface RuleLike {
  id: string
  priority: number
  enabled: boolean
  conditions: RuleCondition[]
  actions: RuleAction[]
}

/**
 * Wildcard match, case-insensitive: `*` is any run of characters (including none), `?` exactly
 * one. Written as a loop with one backtrack point rather than a regular expression, so no
 * pattern can make it take exponential time.
 */
export function globMatches(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase()
  const t = text.toLowerCase()
  let pi = 0
  let ti = 0
  let star = -1
  let mark = 0
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti])) {
      pi++
      ti++
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++
      mark = ti
    } else if (star !== -1) {
      pi = star + 1
      ti = ++mark
    } else {
      return false
    }
  }
  while (pi < p.length && p[pi] === '*') pi++
  return pi === p.length
}

const textOp = (
  op: 'contains' | 'starts_with' | 'equals' | 'matches',
  value: string,
  text: string,
): boolean => {
  const v = value.toLowerCase()
  const s = text.toLowerCase()
  switch (op) {
    case 'contains':
      return s.includes(v)
    case 'starts_with':
      return s.startsWith(v)
    case 'equals':
      return s === v
    case 'matches':
      return globMatches(value, text)
  }
}

export function conditionMatches(c: RuleCondition, t: RuleInput): boolean {
  switch (c.type) {
    case 'text': {
      const fields =
        c.field === 'description'
          ? [t.descriptionRaw]
          : c.field === 'payee'
            ? [t.payee ?? '']
            : [t.descriptionRaw, t.payee ?? '']
      return fields.some((f) => textOp(c.op, c.value, f))
    }
    case 'amount': {
      const size = Math.abs(t.amountCents)
      return (
        (c.minCents === undefined || size >= c.minCents) &&
        (c.maxCents === undefined || size <= c.maxCents)
      )
    }
    case 'account':
      return t.accountId === c.accountId
    case 'direction':
      return c.direction === 'in' ? t.amountCents > 0 : t.amountCents < 0
  }
}

/** A rule matches only if it has conditions and every one of them holds. */
export const ruleMatches = (rule: Pick<RuleLike, 'conditions'>, t: RuleInput): boolean =>
  rule.conditions.length > 0 && rule.conditions.every((c) => conditionMatches(c, t))

export interface RuleOutcome {
  payee?: string
  categoryId?: string
  spaceId?: string
  reimbursable?: boolean
  linkTransfer?: boolean
  /** Ids of every rule that matched, in the order they ran. */
  matched: string[]
  /** Which rule supplied each change (needed to check that rule's creator may do it). */
  from: Partial<
    Record<'payee' | 'categoryId' | 'spaceId' | 'reimbursable' | 'linkTransfer', string>
  >
}

/**
 * Runs enabled rules in priority order (lowest number first, ties by id). Every matching rule
 * applies, but each kind of change is made by the FIRST rule that asks for it, so a
 * higher-priority rule is never overridden by a later one.
 */
export function evaluateRules(rules: readonly RuleLike[], t: RuleInput): RuleOutcome {
  const out: RuleOutcome = { matched: [], from: {} }
  const ordered = rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1))
  for (const rule of ordered) {
    if (!ruleMatches(rule, t)) continue
    out.matched.push(rule.id)
    for (const a of rule.actions) {
      switch (a.type) {
        case 'set_payee':
          if (out.payee === undefined) {
            out.payee = a.payee
            out.from.payee = rule.id
          }
          break
        case 'set_category':
          if (out.categoryId === undefined) {
            out.categoryId = a.categoryId
            out.from.categoryId = rule.id
          }
          break
        case 'move_to_space':
          if (out.spaceId === undefined) {
            out.spaceId = a.spaceId
            out.from.spaceId = rule.id
          }
          break
        case 'mark_reimbursable':
          if (out.reimbursable === undefined) {
            out.reimbursable = true
            out.from.reimbursable = rule.id
          }
          break
        case 'link_transfer':
          if (out.linkTransfer === undefined) {
            out.linkTransfer = true
            out.from.linkTransfer = rule.id
          }
          break
      }
    }
  }
  return out
}
