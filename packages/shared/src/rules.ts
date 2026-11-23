import { z } from 'zod'
import { centsSchema } from './ledger'

/**
 * Rules (data-model.md): when a NEW transaction matches ALL of a rule's conditions, its actions
 * run. Shared so the server validates what the web form builds.
 *
 * "matches" is a simple wildcard pattern (`*` any run of characters, `?` one character), not a
 * regular expression: user-written regexes can freeze a server (catastrophic backtracking).
 */
export const textFields = ['description', 'payee', 'any'] as const
export const textOps = ['contains', 'starts_with', 'equals', 'matches'] as const

export const textConditionSchema = z.object({
  type: z.literal('text'),
  field: z.enum(textFields),
  op: z.enum(textOps),
  value: z.string().trim().min(1).max(200),
})

/** Compares the size of the amount, ignoring sign (use a direction condition for in/out). */
export const amountConditionSchema = z
  .object({
    type: z.literal('amount'),
    minCents: centsSchema.min(0).optional(),
    maxCents: centsSchema.min(0).optional(),
  })
  .refine(
    (c) => c.minCents !== undefined || c.maxCents !== undefined,
    'Set a minimum, a maximum, or both',
  )
  .refine(
    (c) => c.minCents === undefined || c.maxCents === undefined || c.minCents <= c.maxCents,
    'The minimum is more than the maximum',
  )

export const accountConditionSchema = z.object({
  type: z.literal('account'),
  accountId: z.string().min(1),
})
export const directionConditionSchema = z.object({
  type: z.literal('direction'),
  direction: z.enum(['in', 'out']),
})

export const conditionSchema = z.union([
  textConditionSchema,
  amountConditionSchema,
  accountConditionSchema,
  directionConditionSchema,
])
export type RuleCondition = z.infer<typeof conditionSchema>

export const actionSchema = z.union([
  z.object({ type: z.literal('set_payee'), payee: z.string().trim().min(1).max(120) }),
  z.object({ type: z.literal('set_category'), categoryId: z.string().min(1) }),
  z.object({ type: z.literal('move_to_space'), spaceId: z.string().min(1) }),
  z.object({ type: z.literal('mark_reimbursable') }),
  z.object({ type: z.literal('link_transfer') }),
])
export type RuleAction = z.infer<typeof actionSchema>

const name = z.string().trim().min(1).max(80)
const priority = z.number().int().min(0).max(100000)

export const createRuleSchema = z.object({
  name,
  priority: priority.default(100),
  enabled: z.boolean().default(true),
  conditions: z.array(conditionSchema).min(1, 'Add at least one condition').max(10),
  actions: z.array(actionSchema).min(1, 'Add at least one action').max(10),
})
export type CreateRuleInput = z.infer<typeof createRuleSchema>

export const updateRuleSchema = z
  .object({
    name,
    priority,
    enabled: z.boolean(),
    conditions: z.array(conditionSchema).min(1).max(10),
    actions: z.array(actionSchema).min(1).max(10),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update')
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>

export const previewRuleSchema = z.object({ conditions: z.array(conditionSchema).min(1).max(10) })

export interface RuleView {
  id: string
  spaceId: string
  name: string
  priority: number
  enabled: boolean
  conditions: RuleCondition[]
  actions: RuleAction[]
}

export interface RuleRunSummary {
  /** Transactions looked at. */
  examined: number
  /** Transactions at least one rule changed. */
  changed: number
}
