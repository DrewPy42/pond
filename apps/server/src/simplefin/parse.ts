import { z } from 'zod'
import { decimalStringToCents } from './amounts.js'
import type {
  SimpleFinAccount,
  SimpleFinMessage,
  SimpleFinResult,
  SimpleFinTransaction,
} from './types.js'
import { SimpleFinError } from './types.js'

/**
 * Parses an Account Set. Tolerant of both protocol versions: `errlist` (v2) or the deprecated
 * `errors` strings (v1), `connections` (v2) or `org` (v1), numbers or strings for epochs.
 */
const epoch = z.coerce.number().int().nonnegative()
const money = z.union([z.string(), z.number()]).transform((v) => String(v))

const txSchema = z.object({
  id: z.coerce.string(),
  posted: epoch,
  amount: money,
  description: z.string().default(''),
  transacted_at: epoch.optional(),
  pending: z.boolean().optional(),
})
const accountSchema = z.object({
  id: z.coerce.string(),
  name: z.string(),
  conn_id: z.coerce.string().optional(),
  currency: z.string().default('USD'),
  balance: money,
  'available-balance': money.optional(),
  'balance-date': epoch,
  org: z
    .object({ name: z.string().optional(), domain: z.string().optional() })
    .partial()
    .optional(),
  transactions: z.array(z.unknown()).default([]),
})
const setSchema = z.object({
  errlist: z
    .array(
      z.object({
        code: z.string(),
        msg: z.string(),
        conn_id: z.coerce.string().optional(),
        account_id: z.coerce.string().optional(),
      }),
    )
    .optional(),
  errors: z.array(z.string()).optional(),
  connections: z
    .array(z.object({ conn_id: z.coerce.string(), name: z.string().optional() }))
    .optional(),
  accounts: z.array(z.unknown()).default([]),
})

/** Server text is shown to people: strip control characters and cap the length. */
export function sanitizeMessage(text: string, max = 300): string {
  const cleaned = Array.from(text, (ch) => {
    const code = ch.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : ch
  }).join('')
  return cleaned.replace(/\s+/g, ' ').trim().slice(0, max)
}

export function parseAccountSet(json: unknown): SimpleFinResult {
  const set = setSchema.safeParse(json)
  if (!set.success)
    throw new SimpleFinError('bad_response', 'SimpleFIN returned an unexpected response.')

  const messages: SimpleFinMessage[] = [
    ...(set.data.errlist ?? []).map((e) => ({
      code: sanitizeMessage(e.code, 40),
      msg: sanitizeMessage(e.msg),
      connId: e.conn_id ?? null,
      accountId: e.account_id ?? null,
    })),
    ...(set.data.errors ?? []).map((m) => ({
      code: 'gen',
      msg: sanitizeMessage(m),
      connId: null,
      accountId: null,
    })),
  ]
  const connNames = new Map((set.data.connections ?? []).map((c) => [c.conn_id, c.name ?? null]))

  const accounts: SimpleFinAccount[] = []
  for (const raw of set.data.accounts) {
    const a = accountSchema.safeParse(raw)
    if (!a.success) {
      messages.push({
        code: 'act.baddata',
        msg: 'An account in the response could not be read.',
        connId: null,
        accountId: null,
      })
      continue
    }
    const d = a.data
    const problems: string[] = []
    let balanceCents = 0
    let availableCents: number | null = null
    try {
      balanceCents = decimalStringToCents(d.balance)
      if (d['available-balance'] !== undefined)
        availableCents = decimalStringToCents(d['available-balance'])
    } catch (e) {
      problems.push(`${d.name}: ${(e as Error).message}`)
    }
    const transactions: SimpleFinTransaction[] = []
    for (const rawTx of d.transactions) {
      const t = txSchema.safeParse(rawTx)
      if (!t.success) {
        problems.push(`${d.name}: a transaction could not be read`)
        continue
      }
      try {
        transactions.push({
          id: t.data.id,
          postedEpoch: t.data.posted,
          amountCents: decimalStringToCents(t.data.amount),
          description: sanitizeMessage(t.data.description, 500),
          transactedEpoch: t.data.transacted_at ?? null,
          pending: t.data.pending ?? false,
        })
      } catch (e) {
        problems.push(`${d.name}: ${(e as Error).message}`)
      }
    }
    accounts.push({
      id: d.id,
      name: sanitizeMessage(d.name, 120),
      connId: d.conn_id ?? null,
      currency: /^[A-Za-z]{3}$/.test(d.currency) ? d.currency.toUpperCase() : null,
      balanceCents,
      availableCents,
      balanceEpoch: d['balance-date'],
      orgName: d.org?.name ?? (d.conn_id ? (connNames.get(d.conn_id) ?? null) : null),
      transactions,
      problems,
    })
  }
  return { accounts, messages }
}
