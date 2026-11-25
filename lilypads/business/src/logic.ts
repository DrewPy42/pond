import type { SplitSumRow } from '@pond/sdk'
import type {
  ProfitAndLoss,
  ReportLine,
  TaxSummary,
  TaxSummaryCategory,
  TaxSummaryGroup,
} from './types.js'

/** The pad's rules as small pure functions. Money is integer cents; dates are YYYY-MM-DD. */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}
/** Today on the person's own clock. */
export function today(now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

// ---------- Dates and tax years ----------

/** The first day of the month `monthIndex` months after January of year 0. */
const firstOf = (monthIndex: number): string =>
  `${Math.floor(monthIndex / 12)}-${String((monthIndex % 12) + 1).padStart(2, '0')}-01`
const dayBefore = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
const span = (startIndex: number, months: number) => ({
  from: firstOf(startIndex),
  to: dayBefore(firstOf(startIndex + months)),
})

/** A tax year is named for the calendar year in which it starts. */
export function taxYearOf(date: string, startMonth: number): number {
  const [year, month] = date.split('-').map(Number) as [number, number]
  return month >= startMonth ? year : year - 1
}
export const taxYearRange = (year: number, startMonth: number) =>
  span(year * 12 + startMonth - 1, 12)

export interface Period {
  key: 'month' | 'quarter' | 'year' | 'last_year'
  label: string
  from: string
  to: string
}
/** Quick picks for reports. Quarters are quarters of the tax year. */
export function periodsFor(todayDate: string, startMonth: number): Period[] {
  const [year, month] = todayDate.split('-').map(Number) as [number, number]
  const now = year * 12 + month - 1
  const taxYear = taxYearOf(todayDate, startMonth)
  const yearStart = taxYear * 12 + startMonth - 1
  const quarterStart = yearStart + Math.floor((now - yearStart) / 3) * 3
  return [
    { key: 'month', label: 'This month', ...span(now, 1) },
    { key: 'quarter', label: 'This quarter', ...span(quarterStart, 3) },
    { key: 'year', label: 'This tax year', ...taxYearRange(taxYear, startMonth) },
    { key: 'last_year', label: 'Last tax year', ...taxYearRange(taxYear - 1, startMonth) },
  ]
}

// ---------- Reports ----------

export interface CategoryInfo {
  id: string
  name: string
  taxLine: string | null
}

const sumOf = <T>(list: T[], pick: (x: T) => number): number =>
  list.reduce((total, x) => total + pick(x), 0)

/** Builds profit and loss from per-category split totals (transfers are already left out). */
export function profitAndLoss(
  rows: SplitSumRow[],
  categories: CategoryInfo[],
  range: { from: string; to: string },
): ProfitAndLoss {
  const info = new Map(categories.map((c) => [c.id, c]))
  const income: ReportLine[] = []
  const expenses: ReportLine[] = []
  const uncategorized = { count: 0, netCents: 0 }
  for (const r of rows) {
    const category = r.categoryId ? info.get(r.categoryId) : undefined
    if (!category || !r.kind) {
      uncategorized.count += r.count
      uncategorized.netCents += r.cents
      continue
    }
    if (r.kind === 'transfer') continue
    const line = {
      categoryId: category.id,
      name: category.name,
      taxLine: category.taxLine,
      // Splits are signed (money in is positive), so spending is the negation.
      cents: r.kind === 'income' ? r.cents : 0 - r.cents,
    }
    ;(r.kind === 'income' ? income : expenses).push(line)
  }
  const byName = (a: ReportLine, b: ReportLine) => a.name.localeCompare(b.name)
  income.sort(byName)
  expenses.sort(byName)
  const incomeCents = sumOf(income, (l) => l.cents)
  const expenseCents = sumOf(expenses, (l) => l.cents)
  return {
    ...range,
    income,
    expenses,
    totals: { incomeCents, expenseCents, netCents: incomeCents - expenseCents },
    uncategorized,
  }
}

/** `percent` of an amount, to the nearest cent, using whole numbers only. Halves round away from 0. */
export function countedCents(cents: number, percent: number | null): number {
  if (percent === null) return cents
  const size = Math.floor((Math.abs(cents) * percent + 50) / 100)
  return cents < 0 ? 0 - size : size
}

/** Groups lines by tax line (alphabetically, numbers in order), with "No tax line" last. */
function groupByTaxLine(
  lines: ReportLine[],
  percents: ReadonlyMap<string, number>,
): TaxSummaryGroup[] {
  const groups = new Map<string | null, TaxSummaryCategory[]>()
  for (const l of lines) {
    const key = l.taxLine?.trim() || null
    const percent = percents.get(l.categoryId) ?? null
    const list = groups.get(key) ?? []
    list.push({
      categoryId: l.categoryId,
      name: l.name,
      cents: l.cents,
      percent,
      countedCents: countedCents(l.cents, percent),
    })
    groups.set(key, list)
  }
  return [...groups]
    .sort(([a], [b]) =>
      a === null ? 1 : b === null ? -1 : a.localeCompare(b, undefined, { numeric: true }),
    )
    .map(([taxLine, categories]) => ({
      taxLine,
      categories,
      totalCents: sumOf(categories, (c) => c.cents),
      countedCents: sumOf(categories, (c) => c.countedCents),
    }))
}

export function taxSummary(
  pl: ProfitAndLoss,
  year: number,
  percents: ReadonlyMap<string, number>,
): TaxSummary {
  const expenses = groupByTaxLine(pl.expenses, percents)
  return {
    year,
    from: pl.from,
    to: pl.to,
    // Only spending can be partly counted.
    income: groupByTaxLine(pl.income, new Map()),
    expenses,
    totals: { ...pl.totals, countedExpenseCents: sumOf(expenses, (g) => g.countedCents) },
    uncategorized: pl.uncategorized,
  }
}

// ---------- Private details ----------

/** What a tax ID looks like on screen: at most its last four characters. */
export function maskTaxId(taxId: string): string {
  const chars = taxId.replace(/[^A-Za-z0-9]/g, '')
  // A very short ID would be mostly given away by four characters, so it shows none.
  return `•••••${chars.length >= 6 ? chars.slice(-4) : ''}`
}

// ---------- CSV ----------

/**
 * One text cell. A cell that begins like a formula gets a leading apostrophe, so a bank
 * description can't run as one in a spreadsheet.
 */
export function csvText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
