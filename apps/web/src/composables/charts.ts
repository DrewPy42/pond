import { formatMoney } from '@pond/shared'

/** The arithmetic behind Pond's charts, kept apart from drawing so it can be tested. */

export interface Scale {
  min: number
  max: number
  /** Round values from min to max, for gridlines and labels. */
  ticks: number[]
}

/** A clean axis that always includes zero: steps of 1, 2 or 5 times a power of ten. */
export function niceScale(values: readonly number[], steps = 4): Scale {
  const low = Math.min(0, ...values)
  const high = Math.max(0, ...values)
  // With nothing to show, draw a small axis rather than a broken one.
  const span = high - low || 10_000
  const rough = span / steps
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough)!
  const min = Math.floor(low / step) * step
  const max = Math.max(Math.ceil(high / step) * step, min + step)
  const ticks: number[] = []
  for (let t = min; t <= max + step / 2; t += step) ticks.push(Math.round(t))
  return { min, max, ticks }
}

/** Where a value sits on the scale, 0 at the bottom and 100 at the top. */
export const position = (value: number, scale: Scale): number =>
  ((value - scale.min) / (scale.max - scale.min)) * 100

/** A short axis label for an amount in cents: $950, $1.2K, -$45K, $3M. */
export function compactMoney(cents: number, currency = 'USD'): string {
  const dollars = Math.abs(cents) / 100
  const [size, suffix] =
    dollars >= 1_000_000
      ? [dollars / 1_000_000, 'M']
      : dollars >= 1_000
        ? [dollars / 1_000, 'K']
        : [dollars, '']
  const number = Number.isInteger(size) ? String(size) : String(Math.round(size * 10) / 10)
  const symbol = formatMoney(0, currency).replace(/[\d.,\s]/g, '')
  return `${cents < 0 ? '-' : ''}${symbol}${number}${suffix}`
}

/** "Mar" or, where the year changes or at the start, "Mar 2030". */
export function monthLabel(month: string, withYear: boolean): string {
  return new Date(`${month.slice(0, 7)}-15T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  })
}

/** Show about `most` labels along a time axis, always including the last. */
export function labelEvery(count: number, most = 8): (index: number) => boolean {
  const every = Math.max(1, Math.ceil(count / most))
  return (i) => (count - 1 - i) % every === 0
}

/**
 * Labels for a row of months ("YYYY-MM" or dates), one per column, empty where left out. The year
 * is written only on the first label and where it changes, so labels fit on a phone.
 */
export function axisLabels(months: readonly string[], most = 6): string[] {
  const show = labelEvery(months.length, most)
  let year = ''
  return months.map((m, i) => {
    if (!show(i)) return ''
    const withYear = m.slice(0, 4) !== year
    year = m.slice(0, 4)
    return monthLabel(m, withYear)
  })
}

/** A line's share of the total spending, as a whole percent. Refund lines have none. */
export const sharePercent = (cents: number, positiveTotal: number): number =>
  cents > 0 && positiveTotal > 0 ? Math.round((cents * 100) / positiveTotal) : 0
