import { isoDateSchema } from '@pond/shared'
import type { Request, Response } from 'express'
import { z, type ZodType } from 'zod'
import type { AppContext } from '../context.js'
import { sendError } from '../http.js'
import type { createSpaceRouter } from '../middleware/spaceRouter.js'
import { cashFlow, monthsFrom, netWorth, spending } from '../reports/service.js'

/** The longest span a report covers, so one request can't grind a small computer. */
const MAX_MONTHS = 120

const month = z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/)
const cashFlowQuery = z
  .object({ from: month, to: month })
  .refine((q) => q.from <= q.to, 'The start is after the end')
  .refine((q) => monthsFrom(q.from, q.to).length <= MAX_MONTHS, 'Choose a shorter range')
const spendingQuery = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((q) => q.from <= q.to, 'The start is after the end')
const netWorthQuery = z.object({
  /** The person's own "today". */
  today: isoDateSchema,
  months: z.coerce.number().int().min(1).max(MAX_MONTHS).default(12),
})

/** Core reports: anyone who can see the Space can read them. */
export function registerReportRoutes(
  ctx: AppContext,
  sp: ReturnType<typeof createSpaceRouter>,
): void {
  const report =
    <T>(schema: ZodType<T>, build: (spaceId: string, query: T) => unknown) =>
    (req: Request, res: Response) => {
      const q = schema.safeParse(req.query)
      if (!q.success) {
        return sendError(res, 400, 'invalid_input', {
          issues: q.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      }
      res.json(build(req.space!.id, q.data))
    }

  sp.get(
    '/reports/cash-flow',
    'viewer',
    report(cashFlowQuery, (id, q) => cashFlow(ctx.repos, id, q.from, q.to)),
  )
  sp.get(
    '/reports/spending',
    'viewer',
    report(spendingQuery, (id, q) => spending(ctx.repos, id, q.from, q.to)),
  )
  sp.get(
    '/reports/net-worth',
    'viewer',
    report(netWorthQuery, (id, q) => netWorth(ctx.repos, id, q.today, q.months)),
  )
}
