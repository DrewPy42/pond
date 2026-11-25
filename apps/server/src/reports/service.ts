import type {
  CashFlowReport,
  NetWorthPoint,
  NetWorthReport,
  SpendingLine,
  SpendingReport,
} from '@pond/shared'
import type { AccountRecord, Repos } from '../repos/types.js'

/**
 * Core reports for one Space. Income and spending come from `reports.sumSplits`, the one way Pond
 * totals money, so they agree with LilyPads: splits only, no transfers, no removed transactions,
 * one currency. Net worth comes from balance snapshots.
 */

/** The month `n` months after `month` (YYYY-MM). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const i = y * 12 + (m - 1) + n
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`
}
export function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}
export function monthsFrom(from: string, to: string): string[] {
  const out: string[] = []
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m)
  return out
}

const accountsOf = (repos: Repos, spaceId: string) =>
  repos.accounts.listForSpace(spaceId, { includeArchived: true })

function otherCurrencyAccounts(repos: Repos, spaceId: string): number {
  const currency = repos.spaces.findById(spaceId)!.currency
  return accountsOf(repos, spaceId).filter((a) => a.currency !== currency).length
}

export function cashFlow(repos: Repos, spaceId: string, from: string, to: string): CashFlowReport {
  const months = new Map(
    monthsFrom(from, to).map((m) => [m, { month: m, inCents: 0, outCents: 0 }]),
  )
  let uncategorizedCount = 0
  const rows = repos.reports.sumSplits(spaceId, {
    from: `${from}-01`,
    to: lastDayOf(to),
    groupBy: 'category_month',
  })
  for (const r of rows) {
    const m = months.get(r.month!)!
    if (r.kind === 'income') m.inCents += r.cents
    // Spending is money out, so a refund lowers it.
    else if (r.kind === 'expense') m.outCents -= r.cents
    else {
      // Nobody has said what this is, so its direction is all there is to go on.
      m.inCents += r.inCents
      m.outCents += r.inCents - r.cents
      uncategorizedCount += r.count
    }
  }
  const list = [...months.values()].map((m) => ({ ...m, netCents: m.inCents - m.outCents }))
  const sum = (pick: (m: (typeof list)[number]) => number) => list.reduce((n, m) => n + pick(m), 0)
  return {
    months: list,
    totals: {
      inCents: sum((m) => m.inCents),
      outCents: sum((m) => m.outCents),
      netCents: sum((m) => m.netCents),
    },
    uncategorizedCount,
    otherCurrencyAccounts: otherCurrencyAccounts(repos, spaceId),
  }
}

export function spending(repos: Repos, spaceId: string, from: string, to: string): SpendingReport {
  const names = new Map(
    repos.categories.listForSpace(spaceId, { includeArchived: true }).map((c) => [c.id, c.name]),
  )
  const lines: SpendingLine[] = []
  for (const r of repos.reports.sumSplits(spaceId, { from, to, groupBy: 'category' })) {
    if (r.kind === 'expense' && r.categoryId) {
      lines.push({
        categoryId: r.categoryId,
        name: names.get(r.categoryId) ?? 'Unknown category',
        cents: 0 - r.cents,
      })
    } else if (!r.kind) {
      const out = r.inCents - r.cents
      if (out > 0) lines.push({ categoryId: null, name: 'No category', cents: out })
    }
  }
  lines.sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name))
  return {
    from,
    to,
    lines,
    totalCents: lines.reduce((n, l) => n + l.cents, 0),
    otherCurrencyAccounts: otherCurrencyAccounts(repos, spaceId),
  }
}

/** Enough daily snapshots for decades. */
const ALL_SNAPSHOTS = 40_000

/**
 * Net worth at the end of each of the last `months` months (today for the current one). Each
 * account counts with its latest balance on or before that day. Debts are negative balances.
 */
export function netWorth(
  repos: Repos,
  spaceId: string,
  today: string,
  months: number,
): NetWorthReport {
  const currency = repos.spaces.findById(spaceId)!.currency
  const wanted = accountsOf(repos, spaceId).filter((a) => a.includeInNetWorth && !a.hidden)
  const counted = wanted.filter((a) => a.currency === currency)
  // Newest first, as the repository returns them.
  const history = new Map(
    counted.map((a) => [a.id, repos.balances.listForAccount(a.id, { limit: ALL_SNAPSHOTS })]),
  )
  const balanceOn = (a: AccountRecord, date: string) =>
    history.get(a.id)!.find((s) => s.date <= date)
  // An archived account counts up to the day it was archived, so the past doesn't change.
  const openOn = (a: AccountRecord, date: string) =>
    !a.archivedAt || a.archivedAt.slice(0, 10) > date

  const thisMonth = today.slice(0, 7)
  const points: NetWorthPoint[] = []
  for (const month of monthsFrom(addMonths(thisMonth, 1 - months), thisMonth)) {
    const date = month === thisMonth ? today : lastDayOf(month)
    let assetsCents = 0
    let debtsCents = 0
    let known = 0
    let missing = 0
    for (const a of counted) {
      if (!openOn(a, date)) continue
      const snapshot = balanceOn(a, date)
      if (!snapshot) {
        missing++
        continue
      }
      known++
      if (snapshot.balanceCents >= 0) assetsCents += snapshot.balanceCents
      else debtsCents -= snapshot.balanceCents
    }
    // Nothing to say about months before the first balance.
    if (known === 0 && points.length === 0) continue
    points.push({ date, netCents: assetsCents - debtsCents, assetsCents, debtsCents, missing })
  }

  return {
    points,
    accounts: counted
      .filter((a) => openOn(a, today))
      .map((a) => {
        const s = balanceOn(a, today)
        return {
          accountId: a.id,
          name: a.nickname ?? a.name,
          type: a.type,
          balanceCents: s?.balanceCents ?? null,
          balanceDate: s?.date ?? null,
        }
      }),
    otherCurrencyAccounts: wanted.length - counted.length,
  }
}
