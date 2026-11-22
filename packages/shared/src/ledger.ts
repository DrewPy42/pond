import { z } from 'zod'

/**
 * Request shapes for the ledger API, shared by the server (validation at the route boundary)
 * and the web app (forms). Money is always integer cents; positive means money into the
 * account (CLAUDE.md rule 2).
 */

/** A real calendar day, YYYY-MM-DD. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((d) => {
    const t = new Date(`${d}T00:00:00Z`)
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
  }, 'Not a real date')

/** Whole cents; limited so sums can never leave JavaScript's safe integer range. */
export const centsSchema = z.number().int().min(-1e12).max(1e12)

export const accountTypes = [
  'checking',
  'savings',
  'credit_card',
  'loan',
  'brokerage',
  'retirement',
  'cash',
  'property',
  'other',
] as const
export const accountTypeSchema = z.enum(accountTypes)
export type AccountTypeName = (typeof accountTypes)[number]

const text = (max: number) => z.string().trim().min(1).max(max)

export const createAccountSchema = z.object({
  name: text(80),
  type: accountTypeSchema,
  nickname: text(80).optional(),
  institutionName: text(80).optional(),
  lastFour: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  includeInNetWorth: z.boolean().default(true),
  /** Optional starting balance, recorded as today's snapshot. */
  openingBalanceCents: centsSchema.optional(),
  openingBalanceDate: isoDateSchema.optional(),
})
export type CreateAccountInput = z.infer<typeof createAccountSchema>

export const updateAccountSchema = z
  .object({
    name: text(80),
    nickname: text(80).nullable(),
    institutionName: text(80).nullable(),
    type: accountTypeSchema,
    lastFour: z
      .string()
      .regex(/^\d{4}$/)
      .nullable(),
    includeInNetWorth: z.boolean(),
    hidden: z.boolean(),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update')
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>

export const setBalanceSchema = z.object({
  balanceCents: centsSchema,
  availableCents: centsSchema.nullable().optional(),
})

export const categoryKindSchema = z.enum(['income', 'expense', 'transfer'])
export const createCategorySchema = z.object({
  name: text(80),
  kind: categoryKindSchema,
  taxLine: text(80).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
})
export const updateCategorySchema = z
  .object({
    name: text(80),
    kind: categoryKindSchema,
    taxLine: text(80).nullable(),
    sortOrder: z.number().int().min(0).max(100000),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update')

export const splitInputSchema = z.object({
  spaceId: z.string().min(1),
  categoryId: z.string().min(1).nullable().optional(),
  amountCents: centsSchema,
  memo: z.string().trim().max(500).nullable().optional(),
  reimbursable: z.boolean().optional(),
})
export type SplitInputBody = z.infer<typeof splitInputSchema>

export const createTransactionSchema = z.object({
  accountId: z.string().min(1),
  date: isoDateSchema,
  amountCents: centsSchema.refine((n) => n !== 0, "Amount can't be zero"),
  description: text(200),
  payee: text(120).optional(),
  memo: z.string().trim().max(500).optional(),
  pending: z.boolean().optional(),
  /** Omit for the common case: one split covering everything, uncategorized, in this Space. */
  splits: z.array(splitInputSchema).min(1).max(50).optional(),
})
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>

export const updateTransactionSchema = z
  .object({
    date: isoDateSchema,
    amountCents: centsSchema.refine((n) => n !== 0, "Amount can't be zero"),
    description: text(200),
    payee: text(120).nullable(),
    memo: z.string().trim().max(500).nullable(),
    pending: z.boolean(),
    private: z.boolean(),
    needsReview: z.boolean(),
    /** Replaces all splits. Required if the amount changes and there is more than one split. */
    splits: z.array(splitInputSchema).min(1).max(50),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update')
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>

export const transactionQuerySchema = z.object({
  accountId: z.string().min(1).optional(),
  categoryId: z.string().min(1).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
})
export type TransactionQuery = z.infer<typeof transactionQuerySchema>

export const linkTransferSchema = z.object({
  transactionId: z.string().min(1),
  otherTransactionId: z.string().min(1),
})
