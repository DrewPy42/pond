/**
 * The pad's rules as small pure functions, so they can be tested without a server or a database.
 * Money is integer cents throughout.
 */

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** True for a real calendar day written YYYY-MM-DD. */
export function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** The month containing a YYYY-MM-DD day. */
export const monthOf = (date: string): string => date.slice(0, 7)

/** This month on the user's own clock, as YYYY-MM. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}
/** Today on the user's own clock, as YYYY-MM-DD. */
export function today(now: Date = new Date()): string {
  return `${currentMonth(now)}-${String(now.getDate()).padStart(2, '0')}`
}

/** Move a YYYY-MM by whole months (negative goes back). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const index = y * 12 + (m - 1) + n
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** First and last calendar day of a month, inclusive. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` }
}

export interface BudgetRow {
  month: string
  amountCents: number
}

/**
 * The amount that applies to `month`: the latest row at or before it. Null means the category
 * isn't tracked that month (no row yet, or the latest row says 0).
 */
export function amountForMonth(rows: readonly BudgetRow[], month: string): number | null {
  let best: BudgetRow | null = null
  for (const r of rows) if (r.month <= month && (!best || r.month > best.month)) best = r
  return best && best.amountCents > 0 ? best.amountCents : null
}

/**
 * Turns three months of spending into a starting budget: the monthly average, rounded to the
 * nearest whole dollar. Nothing is suggested for a category with no spending.
 */
export function suggestCents(totalSpentCents: number): number {
  if (totalSpentCents <= 0) return 0
  return Math.floor((totalSpentCents + 150) / 300) * 100
}

/** Months from `fromMonth` to `toMonth` (0 when the same month, negative when already past). */
export function monthsBetween(fromMonth: string, toMonth: string): number {
  const [fy, fm] = fromMonth.split('-').map(Number) as [number, number]
  const [ty, tm] = toMonth.split('-').map(Number) as [number, number]
  return (ty - fy) * 12 + (tm - fm)
}

/** Percent of the goal reached, a whole number from 0 to 100. */
export function percentSaved(savedCents: number, targetCents: number): number {
  if (targetCents <= 0 || savedCents <= 0) return 0
  return Math.min(100, Math.floor((savedCents * 100) / targetCents))
}

/**
 * About how much to put aside each month to reach the target by its date, counting this month.
 * Null when there is no date or it has passed; 0 when the goal is already met.
 */
export function monthlyNeededCents(
  targetCents: number,
  savedCents: number,
  targetDate: string | null,
  todayDate: string,
): number | null {
  if (!targetDate || targetDate < todayDate) return null
  const left = targetCents - Math.max(savedCents, 0)
  if (left <= 0) return 0
  const months = Math.max(1, monthsBetween(monthOf(todayDate), monthOf(targetDate)) + 1)
  return Math.ceil(left / months)
}
