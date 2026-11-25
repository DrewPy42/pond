import { PadError, z, type PadContext, type PadScope } from '@pond/sdk'
import { formatCents } from '@pond/shared'
import { csvText, isRealDate, profitAndLoss, taxSummary, taxYearRange } from './logic.js'

const day = z.string().refine(isRealDate, 'Use a date like 2030-06-15')
const rangeQuery = z
  .object({ from: day, to: day })
  .refine((r) => r.from <= r.to, 'The start date is after the end date')

/** The most transactions one export will include, so a huge range can't exhaust a small computer. */
const EXPORT_LIMIT = 20_000

export async function taxYearStartMonth(scope: PadScope): Promise<number> {
  const row = await scope.db.table('profile').findOne({ slot: 'profile' })
  return (row?.tax_year_start_month as number | undefined) ?? 1
}

async function buildProfitAndLoss(scope: PadScope, range: { from: string; to: string }) {
  const [rows, categories] = await Promise.all([
    scope.core.splits.sum({ ...range, groupBy: 'category' }),
    // Archived categories can still have money in an older period.
    scope.core.categories.list({ includeArchived: true }),
  ])
  return profitAndLoss(rows, categories, range)
}

async function percents(scope: PadScope): Promise<Map<string, number>> {
  const rows = await scope.db.table('deductions').find({ limit: 1000 })
  return new Map(rows.map((r) => [r.category_id as string, r.percent as number]))
}

/** One row per split that belongs to this Space (never another Space's share of a transaction). */
async function exportCsv(scope: PadScope, range: { from: string; to: string }): Promise<string> {
  const categories = new Map(
    (await scope.core.categories.list({ includeArchived: true })).map((c) => [c.id, c]),
  )
  const rows: { date: string; line: string }[] = []
  let offset = 0
  for (;;) {
    const page = await scope.core.transactions.list({ ...range, limit: 200, offset })
    if (page.total > EXPORT_LIMIT) throw new PadError(400, 'too_many_to_export')
    for (const t of page.transactions) {
      for (const s of t.splits) {
        if (s.spaceId !== scope.space.id) continue
        const c = s.categoryId ? categories.get(s.categoryId) : undefined
        const type = t.linkedTransfer ? 'transfer' : (c?.kind ?? 'uncategorized')
        rows.push({
          date: t.date,
          line: [
            t.date,
            csvText(t.descriptionRaw),
            csvText(t.payee ?? ''),
            // Signed, as in the bank: money in is positive. Not text, so it isn't escaped.
            formatCents(s.amountCents),
            type,
            csvText(c?.name ?? ''),
            csvText(c?.taxLine ?? ''),
            csvText(s.memo ?? ''),
            t.pending ? 'yes' : '',
          ].join(','),
        })
      }
    }
    offset += 200
    if (offset >= page.total) break
  }
  rows.sort((a, b) => a.date.localeCompare(b.date))
  const header = 'Date,Description,Payee,Amount,Type,Category,Tax line,Memo,Pending'
  return [header, ...rows.map((r) => r.line)].join('\r\n') + '\r\n'
}

export function registerReports(ctx: PadContext): void {
  // What the report screens need that otherwise lives in the owner-only profile.
  ctx.router.get('/reports/context', { role: 'viewer' }, async (req) => ({
    taxYearStartMonth: await taxYearStartMonth(req),
  }))

  ctx.router.get('/reports/profit-loss', { role: 'viewer', query: rangeQuery }, (req) =>
    buildProfitAndLoss(req, req.query),
  )

  ctx.router.get(
    '/reports/tax-summary',
    {
      role: 'viewer',
      query: z.object({ year: z.coerce.number().int().min(1990).max(2200) }),
    },
    async (req) => {
      const range = taxYearRange(req.query.year, await taxYearStartMonth(req))
      return taxSummary(await buildProfitAndLoss(req, range), req.query.year, await percents(req))
    },
  )

  ctx.router.get('/reports/export', { role: 'viewer', query: rangeQuery }, async (req) => ({
    filename: `transactions-${req.query.from}-to-${req.query.to}.csv`,
    csv: await exportCsv(req, req.query),
  }))

  // "Only part of this category counts." 100 or null goes back to counting it in full.
  ctx.router.put(
    '/reports/deductions/:categoryId',
    { role: 'owner', body: z.object({ percent: z.number().int().min(0).max(100).nullable() }) },
    async (req) => {
      const categoryId = req.params.categoryId!
      const categories = await req.core.categories.list({ includeArchived: true })
      if (!categories.some((c) => c.id === categoryId && c.kind === 'expense'))
        throw new PadError(400, 'invalid_category')
      const table = req.db.table('deductions')
      const { percent } = req.body
      if (percent === null || percent === 100) await table.delete({ category_id: categoryId })
      else if ((await table.update({ category_id: categoryId }, { percent })) === 0)
        await table.insert({ category_id: categoryId, percent })
      await req.audit.record({
        action: 'deduction.changed',
        targetType: 'category',
        targetId: categoryId,
        meta: { percent },
      })
      return { ok: true }
    },
  )
}
