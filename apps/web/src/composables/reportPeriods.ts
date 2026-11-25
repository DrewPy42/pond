/** Date ranges for the report pickers, worked out on the person's own clock. */

const two = (n: number) => String(n).padStart(2, '0')
export const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
export const isoMonth = (d: Date): string => isoDay(d).slice(0, 7)

/** The month `back` months before this one. */
export const monthsAgo = (back: number, now: Date = new Date()): string =>
  isoMonth(new Date(now.getFullYear(), now.getMonth() - back, 1))

export interface DayRange {
  key: string
  title: string
  from: string
  to: string
}

export function spendingPeriods(now: Date = new Date()): DayRange[] {
  const y = now.getFullYear()
  const m = now.getMonth()
  const range = (key: string, title: string, from: Date, to: Date): DayRange => ({
    key,
    title,
    from: isoDay(from),
    to: isoDay(to),
  })
  return [
    range('month', 'This month', new Date(y, m, 1), new Date(y, m + 1, 0)),
    range('last-month', 'Last month', new Date(y, m - 1, 1), new Date(y, m, 0)),
    range('year', 'This year', new Date(y, 0, 1), new Date(y, 11, 31)),
    range('12-months', 'Last 12 months', new Date(y, m - 11, 1), new Date(y, m + 1, 0)),
  ]
}
