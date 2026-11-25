import { describe, expect, it } from 'vitest'
import { axisLabels, compactMoney, labelEvery, niceScale, position, sharePercent } from './charts'
import { monthsAgo, spendingPeriods } from './reportPeriods'

describe('niceScale and position', () => {
  /**
   * Function: niceScale
   * Inputs:   amounts up to 873,000 cents; values from -120,000 to 450,000; nothing at all
   * Expected: round steps that cover the data and include zero; a small default axis when empty
   */
  it('makes round axes that include zero', () => {
    expect(niceScale([873000, 1000]).ticks).toEqual([0, 500000, 1000000])
    expect(niceScale([450000, -120000]).ticks).toEqual([-200000, 0, 200000, 400000, 600000])
    expect(niceScale([]).min).toBe(0)
    expect(niceScale([0, 0]).max).toBeGreaterThan(0)
  })

  /**
   * Function: position
   * Inputs:   a -100 to 300 scale; values -100, 0, 300
   * Expected: 0, 25 and 100 percent of the height
   */
  it('places values on the scale', () => {
    const scale = { min: -100, max: 300, ticks: [] }
    expect([-100, 0, 300].map((v) => position(v, scale))).toEqual([0, 25, 100])
  })
})

describe('labels and shares', () => {
  /**
   * Function: compactMoney
   * Inputs:   $0, $950, $1,200, -$45,000, $3,000,000, and a euro amount
   * Expected: short forms with the currency sign
   */
  it('shortens money for axis labels', () => {
    expect([0, 95000, 120000, -4500000, 300000000].map((c) => compactMoney(c))).toEqual([
      '$0',
      '$950',
      '$1.2K',
      '-$45K',
      '$3M',
    ])
    expect(compactMoney(200000, 'EUR')).toBe('€2K')
  })

  /**
   * Function: labelEvery, sharePercent
   * Inputs:   24 points with room for 8; 6 points; a refund line and a normal one
   * Expected: every third label ending on the last; all six; refunds get 0%
   */
  it('thins crowded labels and ignores refunds in shares', () => {
    const show = labelEvery(24)
    expect(Array.from({ length: 24 }, (_, i) => i).filter(show)).toEqual([
      2, 5, 8, 11, 14, 17, 20, 23,
    ])
    expect([0, 1, 2, 3, 4, 5].filter(labelEvery(6))).toHaveLength(6)
    expect([sharePercent(250, 1000), sharePercent(-50, 1000), sharePercent(5, 0)]).toEqual([
      25, 0, 0,
    ])
  })
})

describe('axisLabels', () => {
  /**
   * Function: axisLabels
   * Inputs:   12 months from December 2029, room for 6 labels
   * Expected: every other column, ending on the last; the year appears on the first label and
   *           again only if it changes
   */
  it('writes the year only where it changes', () => {
    const months = [
      '2029-12',
      ...Array.from({ length: 11 }, (_, i) => `2030-${String(i + 1).padStart(2, '0')}`),
    ]
    const labels = axisLabels(months)
    const shown = labels.filter(Boolean)
    expect(labels.map((l) => l !== '')).toEqual(months.map((_, i) => i % 2 === 1))
    expect(shown[0]).toContain('2030')
    expect(shown.slice(1).every((l) => !l.includes('2030'))).toBe(true)
    const across = axisLabels(['2029-11', '2029-12', '2030-01'])
    expect(across.map((l) => /\d{4}/.test(l))).toEqual([true, false, true])
  })
})

describe('report periods', () => {
  /**
   * Function: spendingPeriods, monthsAgo
   * Inputs:   today 15 January 2030
   * Expected: this month Jan; last month December 2029; this year 2030; the last 12 months from
   *           February 2029; 11 months ago is February 2029
   */
  it('works across New Year', () => {
    const now = new Date(2030, 0, 15)
    expect(spendingPeriods(now).map((p) => [p.key, p.from, p.to])).toEqual([
      ['month', '2030-01-01', '2030-01-31'],
      ['last-month', '2029-12-01', '2029-12-31'],
      ['year', '2030-01-01', '2030-12-31'],
      ['12-months', '2029-02-01', '2030-01-31'],
    ])
    expect(monthsAgo(11, now)).toBe('2029-02')
  })
})
