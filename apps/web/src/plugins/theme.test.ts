import { describe, expect, it } from 'vitest'
import { pondDark, pondLight } from './theme'

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** The colour seen when `fg` is drawn over `bg` at the given opacity. */
function mix(fg: string, bg: string, alpha: number): string {
  const channel = (i: number) =>
    Math.round(
      parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha),
    )
      .toString(16)
      .padStart(2, '0')
  return `#${[1, 3, 5].map(channel).join('')}`
}

// Function: pondLight / pondDark theme definitions (apps/web/src/plugins/theme.ts)
// Inputs:   every text colour paired with the background it is drawn on, in both themes
//           (e.g. on-primary on primary, link on background, money-in on surface)
// Expected: a WCAG contrast ratio of at least 4.5:1 for each pair (CLAUDE.md contrast rule)
describe.each([
  ['light', pondLight],
  ['dark', pondDark],
])('%s theme meets WCAG AA (4.5:1) for text', (_name, theme) => {
  const c = theme.colors as Record<string, string>
  const pairs: [string, string][] = [
    ['on-background', 'background'],
    ['on-surface', 'surface'],
    ['on-primary', 'primary'],
    ['on-secondary', 'secondary'],
    ['on-warning', 'warning'],
    ['on-error', 'error'],
    ['on-info', 'info'],
    ['on-success', 'success'],
    ['error-text', 'background'],
    ['error-text', 'surface'],
    ['link', 'background'],
    ['link', 'surface'],
    ['money-in', 'background'],
    ['money-in', 'surface'],
    ['money-out', 'background'],
    ['money-out', 'surface'],
  ]
  it.each(pairs)('%s on %s', (fg, bg) => {
    expect(contrast(c[fg]!, c[bg]!)).toBeGreaterThanOrEqual(4.5)
  })

  // Inputs:   muted text (high-emphasis x medium-emphasis opacity, as in lists and fields) on a
  //           card, on the page, and on a filled field on the page (4% tint, 9% when hovered)
  // Expected: a contrast ratio of at least 4.5:1 on each
  const v = theme.variables as Record<string, number>
  const alpha = v['high-emphasis-opacity']! * v['medium-emphasis-opacity']!
  it.each([
    ['surface', 0],
    ['background', 0],
    ['background', 0.04],
    ['background', 0.09],
  ])('muted text on %s with a %s tint', (name, tint) => {
    const bg = mix(c['on-surface']!, c[name]!, tint)
    expect(contrast(mix(c['on-surface']!, bg, alpha), bg)).toBeGreaterThanOrEqual(4.5)
  })
})
