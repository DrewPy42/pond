import {
  MAX_LIMIT,
  PadError,
  definePad,
  z,
  type PadScope,
  type Row,
  type TableApi,
} from '@pond/sdk'
import {
  MONTH_RE,
  addMonths,
  amountForMonth,
  isRealDate,
  monthBounds,
  monthOf,
  percentSaved,
  suggestCents,
} from './logic.js'

const month = z.string().regex(MONTH_RE, 'Use a month like 2030-06')
const day = z.string().refine(isRealDate, 'Use a date like 2030-06-15')
const cents = z.number().int().min(0).max(100_000_000_00)

/** Every row of a table, read a page at a time so a long history is never silently cut off. */
async function allRows(table: TableApi, orderBy: [string, 'asc' | 'desc'][]): Promise<Row[]> {
  const rows: Row[] = []
  for (;;) {
    const page = await table.find({ orderBy, limit: MAX_LIMIT, offset: rows.length })
    rows.push(...page)
    if (page.length < MAX_LIMIT) return rows
  }
}

interface BudgetLine {
  categoryId: string
  name: string
  budgetedCents: number
  spentCents: number
  leftCents: number
}

/** Expense categories a person can budget (transfers and income are never spending). */
async function budgetableCategories(scope: PadScope) {
  const all = await scope.core.categories.list()
  return all.filter((c) => c.kind === 'expense')
}

/** What was spent per category in one month: splits only, transfers excluded by the host. */
async function spentByCategory(scope: PadScope, from: string, to: string) {
  const rows = await scope.core.splits.sum({ from, to, groupBy: 'category' })
  const out = new Map<string, number>()
  for (const r of rows) {
    if (r.kind === 'expense' && r.categoryId) out.set(r.categoryId, -r.cents)
  }
  return out
}

/** The budget for one month: each budgeted category with spent and left. */
async function buildBudget(scope: PadScope, m: string) {
  const [categories, rows] = await Promise.all([
    budgetableCategories(scope),
    allRows(scope.db.table('budgets'), [['created_at', 'asc']]),
  ])
  const { from, to } = monthBounds(m)
  const spent = await spentByCategory(scope, from, to)
  const byCategory = new Map<string, { month: string; amountCents: number }[]>()
  for (const r of rows) {
    const list = byCategory.get(r.category_id as string) ?? []
    list.push({ month: r.month as string, amountCents: r.amount_cents as number })
    byCategory.set(r.category_id as string, list)
  }
  const lines: BudgetLine[] = []
  const available: { id: string; name: string }[] = []
  for (const c of categories) {
    const budgeted = amountForMonth(byCategory.get(c.id) ?? [], m)
    if (budgeted === null) {
      available.push({ id: c.id, name: c.name })
      continue
    }
    const spentCents = spent.get(c.id) ?? 0
    lines.push({
      categoryId: c.id,
      name: c.name,
      budgetedCents: budgeted,
      spentCents,
      leftCents: budgeted - spentCents,
    })
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  lines.sort(byName)
  available.sort(byName)
  const budgetedCents = lines.reduce((n, l) => n + l.budgetedCents, 0)
  const spentCents = lines.reduce((n, l) => n + l.spentCents, 0)
  return {
    month: m,
    lines,
    available,
    totals: { budgetedCents, spentCents, leftCents: budgetedCents - spentCents },
  }
}

export default definePad({
  register(ctx) {
    // ---------- Budgets ----------

    ctx.router.get('/budget', { role: 'viewer', query: z.object({ month }) }, (req) =>
      buildBudget(req, req.query.month),
    )

    // A starting point: last three months' average spending, per category. Writes nothing.
    ctx.router.get(
      '/budget/suggest',
      { role: 'viewer', query: z.object({ month }) },
      async (req) => {
        const first = monthBounds(addMonths(req.query.month, -3)).from
        const last = monthBounds(addMonths(req.query.month, -1)).to
        const [categories, spent] = await Promise.all([
          budgetableCategories(req),
          spentByCategory(req, first, last),
        ])
        const suggestions = categories
          .map((c) => ({
            categoryId: c.id,
            name: c.name,
            amountCents: suggestCents(spent.get(c.id) ?? 0),
          }))
          .filter((s) => s.amountCents > 0)
          .sort((a, b) => b.amountCents - a.amountCents)
        return { suggestions }
      },
    )

    // Sets amounts from this month on. Several at once so a suggested budget is one request.
    ctx.router.put(
      '/budget',
      {
        role: 'editor',
        body: z.object({
          month,
          items: z
            .array(z.object({ categoryId: z.string().min(1).max(64), amountCents: cents }))
            .min(1)
            .max(200),
        }),
      },
      async (req) => {
        const allowed = new Set((await budgetableCategories(req)).map((c) => c.id))
        for (const i of req.body.items)
          if (!allowed.has(i.categoryId)) throw new PadError(400, 'invalid_category')
        const table = req.db.table('budgets')
        for (const i of req.body.items) {
          const where = { category_id: i.categoryId, month: req.body.month }
          if ((await table.update(where, { amount_cents: i.amountCents })) === 0)
            await table.insert({ ...where, amount_cents: i.amountCents })
          // "Stop tracking" with nothing earlier to cancel out leaves no row behind.
          if (i.amountCents === 0) {
            const earlier = await table.count({
              category_id: i.categoryId,
              month: { lt: req.body.month },
            })
            if (earlier === 0) await table.delete(where)
          }
        }
        await req.audit.record({
          action: 'budget.changed',
          meta: { month: req.body.month, categories: req.body.items.length },
        })
        return { updated: req.body.items.length }
      },
    )

    // For the panel on a transaction: what is left in the budget of each category it touches.
    ctx.router.get('/transactions/:id', { role: 'viewer' }, async (req) => {
      const txn = await req.core.transactions.get(req.params.id!)
      if (!txn) throw new PadError(404, 'not_found')
      const m = monthOf(txn.date)
      const touched = new Set(txn.splits.map((s) => s.categoryId).filter((c): c is string => !!c))
      const budget = await buildBudget(req, m)
      return { month: m, lines: budget.lines.filter((l) => touched.has(l.categoryId)) }
    })

    // ---------- Goals ----------

    ctx.router.get('/accounts', { role: 'viewer' }, async (req) => {
      const accounts = await req.core.accounts.list()
      return {
        accounts: accounts
          .filter((a) => !a.archived && !a.hidden)
          .map((a) => ({ id: a.id, name: a.nickname ?? a.name })),
      }
    })

    ctx.router.get('/goals', { role: 'viewer' }, async (req) => {
      const [goals, contributions, accounts, balances] = await Promise.all([
        req.db.table('goals').find({ orderBy: [['created_at', 'asc']], limit: 200 }),
        allRows(req.db.table('contributions'), [['date', 'desc']]),
        req.core.accounts.list(),
        req.core.balances.latest(),
      ])
      const accountName = new Map(accounts.map((a) => [a.id, a.nickname ?? a.name]))
      const balance = new Map(balances.map((b) => [b.accountId, b.balanceCents]))
      return {
        goals: goals.map((g) => {
          const mine = contributions.filter((c) => c.goal_id === g.id)
          const linked = g.account_id as string | null
          const savedCents = linked
            ? (balance.get(linked) ?? 0)
            : mine.reduce((n, c) => n + (c.amount_cents as number), 0)
          const targetCents = g.target_cents as number
          return {
            id: g.id as string,
            name: g.name as string,
            targetCents,
            targetDate: g.target_date as string | null,
            accountId: linked,
            accountName: linked ? (accountName.get(linked) ?? null) : null,
            savedCents,
            percent: percentSaved(savedCents, targetCents),
            reached: savedCents >= targetCents,
            contributions: linked
              ? []
              : mine.slice(0, 20).map((c) => ({
                  id: c.id as string,
                  date: c.date as string,
                  amountCents: c.amount_cents as number,
                })),
          }
        }),
      }
    })

    ctx.router.post(
      '/goals',
      {
        role: 'editor',
        body: z.object({
          name: z.string().trim().min(1).max(80),
          targetCents: cents.min(1),
          targetDate: day.nullable().optional(),
          accountId: z.string().min(1).max(64).nullable().optional(),
        }),
      },
      async (req) => {
        if (req.body.accountId) {
          const accounts = await req.core.accounts.list()
          if (!accounts.some((a) => a.id === req.body.accountId))
            throw new PadError(400, 'invalid_account')
        }
        const goal = await req.db.table('goals').insert({
          name: req.body.name,
          target_cents: req.body.targetCents,
          target_date: req.body.targetDate ?? null,
          account_id: req.body.accountId ?? null,
        })
        await req.audit.record({
          action: 'goal.created',
          targetType: 'goal',
          targetId: goal.id as string,
        })
        return { id: goal.id }
      },
    )

    ctx.router.patch(
      '/goals/:id',
      {
        role: 'editor',
        body: z.object({
          name: z.string().trim().min(1).max(80).optional(),
          targetCents: cents.min(1).optional(),
          targetDate: day.nullable().optional(),
        }),
      },
      async (req) => {
        const patch: Record<string, string | number | null> = {}
        if (req.body.name !== undefined) patch.name = req.body.name
        if (req.body.targetCents !== undefined) patch.target_cents = req.body.targetCents
        if (req.body.targetDate !== undefined) patch.target_date = req.body.targetDate
        if (Object.keys(patch).length === 0) throw new PadError(400, 'nothing_to_change')
        if ((await req.db.table('goals').update({ id: req.params.id! }, patch)) === 0)
          throw new PadError(404, 'not_found')
        return { ok: true }
      },
    )

    ctx.router.delete('/goals/:id', { role: 'editor' }, async (req) => {
      if ((await req.db.table('goals').delete({ id: req.params.id! })) === 0)
        throw new PadError(404, 'not_found')
      await req.db.table('contributions').delete({ goal_id: req.params.id! })
      await req.audit.record({
        action: 'goal.deleted',
        targetType: 'goal',
        targetId: req.params.id!,
      })
      return { ok: true }
    })

    ctx.router.post(
      '/goals/:id/contributions',
      {
        role: 'editor',
        body: z.object({
          amountCents: z
            .number()
            .int()
            .min(-100_000_000_00)
            .max(100_000_000_00)
            .refine((n) => n !== 0, 'Enter an amount'),
          date: day,
        }),
      },
      async (req) => {
        const goal = await req.db.table('goals').findOne({ id: req.params.id! })
        if (!goal) throw new PadError(404, 'not_found')
        // A goal that follows an account takes its progress from the balance, never from this list.
        if (goal.account_id) throw new PadError(409, 'linked_goal')
        const row = await req.db.table('contributions').insert({
          goal_id: req.params.id!,
          amount_cents: req.body.amountCents,
          date: req.body.date,
        })
        return { id: row.id }
      },
    )

    ctx.router.delete(
      '/goals/:id/contributions/:contributionId',
      { role: 'editor' },
      async (req) => {
        const removed = await req.db
          .table('contributions')
          .delete({ id: req.params.contributionId!, goal_id: req.params.id! })
        if (removed === 0) throw new PadError(404, 'not_found')
        return { ok: true }
      },
    )
  },
})
