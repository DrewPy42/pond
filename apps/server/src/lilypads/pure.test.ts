import type { Schedule, SettingField } from '@pond/sdk'
import { describe, expect, it } from 'vitest'
import { isPlainJson, jsonGuard } from './json'
import { isDue, latestOccurrence, validateSchedule } from './schedule'
import { SettingError, checkSettingValue } from './settings'

// Pure pieces of the LilyPad host: no repositories, no app.

const at = (iso: string) => new Date(iso)
const iso = (d: Date) => d.toISOString()

describe('validateSchedule(schedule)', () => {
  /**
   * Inputs:   daily 06:00, weekly Monday 23:59, monthly day 28 at 00:00
   * Expected: all accepted
   */
  it('accepts valid daily, weekly and monthly schedules', () => {
    for (const s of [
      { daily: { at: '06:00' } },
      { weekly: { day: 1, at: '23:59' } },
      { monthly: { day: 28, at: '00:00' } },
    ] as Schedule[]) {
      expect(() => validateSchedule(s)).not.toThrow()
    }
  })
  /**
   * Inputs:   a bad time ("6:00", "24:00"), weekly day 7, monthly day 0 and 29 (not every month has them), a cron string
   * Expected: each throws a readable error
   */
  it('refuses bad times, days and cron strings', () => {
    for (const s of [
      { daily: { at: '6:00' } },
      { daily: { at: '24:00' } },
      { weekly: { day: 7, at: '06:00' } },
      { monthly: { day: 0, at: '06:00' } },
      { monthly: { day: 29, at: '06:00' } },
      '0 6 1 * *',
    ]) {
      expect(() => validateSchedule(s as unknown as Schedule), JSON.stringify(s)).toThrow()
    }
  })
})

describe('latestOccurrence(schedule, now, timeZone)', () => {
  /**
   * Inputs:   daily 06:00 UTC at 05:00 and at 07:00 on Jan 15
   * Expected: Jan 14 06:00 (today's isn't due yet) and Jan 15 06:00
   */
  it('finds the most recent daily time', () => {
    const s: Schedule = { daily: { at: '06:00' } }
    expect(iso(latestOccurrence(s, at('2030-01-15T05:00:00Z'), 'UTC'))).toBe(
      '2030-01-14T06:00:00.000Z',
    )
    expect(iso(latestOccurrence(s, at('2030-01-15T07:00:00Z'), 'UTC'))).toBe(
      '2030-01-15T06:00:00.000Z',
    )
  })
  /**
   * Inputs:   weekly Monday 09:00 UTC checked on a Wednesday and on that Monday at 08:00
   * Expected: this week's Monday 09:00; the previous Monday 09:00
   */
  it('finds the most recent weekly day', () => {
    const s: Schedule = { weekly: { day: 1, at: '09:00' } } // Jan 14 2030 is a Monday
    expect(iso(latestOccurrence(s, at('2030-01-16T12:00:00Z'), 'UTC'))).toBe(
      '2030-01-14T09:00:00.000Z',
    )
    expect(iso(latestOccurrence(s, at('2030-01-14T08:00:00Z'), 'UTC'))).toBe(
      '2030-01-07T09:00:00.000Z',
    )
  })
  /**
   * Inputs:   monthly day 1 at 06:00 checked on Mar 1 at 05:00, Mar 1 at 07:00 and mid-March
   * Expected: Feb 1 06:00; Mar 1 06:00; Mar 1 06:00
   */
  it('finds the most recent monthly day', () => {
    const s: Schedule = { monthly: { day: 1, at: '06:00' } }
    expect(iso(latestOccurrence(s, at('2030-03-01T05:00:00Z'), 'UTC'))).toBe(
      '2030-02-01T06:00:00.000Z',
    )
    expect(iso(latestOccurrence(s, at('2030-03-01T07:00:00Z'), 'UTC'))).toBe(
      '2030-03-01T06:00:00.000Z',
    )
    expect(iso(latestOccurrence(s, at('2030-03-15T00:00:00Z'), 'UTC'))).toBe(
      '2030-03-01T06:00:00.000Z',
    )
  })
  /**
   * Inputs:   daily 06:00 in America/New_York in winter (UTC-5) and in summer (UTC-4)
   * Expected: 11:00 UTC in January and 10:00 UTC in July (local wall-clock time, daylight saving respected)
   */
  it('uses local time, including daylight saving', () => {
    const s: Schedule = { daily: { at: '06:00' } }
    expect(iso(latestOccurrence(s, at('2030-01-15T20:00:00Z'), 'America/New_York'))).toBe(
      '2030-01-15T11:00:00.000Z',
    )
    expect(iso(latestOccurrence(s, at('2030-07-15T20:00:00Z'), 'America/New_York'))).toBe(
      '2030-07-15T10:00:00.000Z',
    )
  })
})

describe('isDue(schedule, lastRun, now, timeZone)', () => {
  const monthly: Schedule = { monthly: { day: 1, at: '06:00' } }
  /**
   * Inputs:   no last run; last run Jan 15 checked Jan 20; last run Jan 15 checked Feb 1 07:00; last run Feb 1 06:30
   *           checked Feb 1 07:00; last run Jan 1 checked in June
   * Expected: false (first sight only starts the clock); false; true; false (already ran after this occurrence); true
   *           (one catch-up, not one per missed month)
   */
  it('runs once an occurrence has passed since the last run', () => {
    expect(isDue(monthly, null, at('2030-02-01T07:00:00Z'), 'UTC')).toBe(false)
    expect(isDue(monthly, at('2030-01-15T00:00:00Z'), at('2030-01-20T00:00:00Z'), 'UTC')).toBe(
      false,
    )
    expect(isDue(monthly, at('2030-01-15T00:00:00Z'), at('2030-02-01T07:00:00Z'), 'UTC')).toBe(true)
    expect(isDue(monthly, at('2030-02-01T06:30:00Z'), at('2030-02-01T07:00:00Z'), 'UTC')).toBe(
      false,
    )
    expect(isDue(monthly, at('2030-01-01T00:00:00Z'), at('2030-06-10T00:00:00Z'), 'UTC')).toBe(true)
  })
})

describe('isPlainJson(value) and jsonGuard', () => {
  /**
   * Inputs:   null, strings, finite numbers, booleans, arrays and plain objects (with an undefined field)
   * Expected: all plain JSON
   */
  it('accepts plain JSON data', () => {
    for (const v of [null, 'a', 1, true, [1, 'a', null], { a: 1, b: { c: [true] }, d: undefined }])
      expect(isPlainJson(v)).toBe(true)
  })
  /**
   * Inputs:   a Date, a function, NaN, Infinity, a Map, a class instance, a BigInt, undefined in an array, a
   *           circular object
   * Expected: none are plain JSON
   */
  it('refuses anything that would not survive a round trip', () => {
    class Thing {}
    const circular: Record<string, unknown> = {}
    circular.me = circular
    for (const v of [
      new Date(),
      () => 1,
      Number.NaN,
      Infinity,
      new Map(),
      new Thing(),
      10n,
      [undefined],
      circular,
    ])
      expect(isPlainJson(v)).toBe(false)
  })
  /**
   * Inputs:   a guarded function called with plain data, with a Date, and returning an object containing a Date
   * Expected: plain call works; the Date argument is refused; a returned Date comes back as a string (JSON round trip)
   */
  it('checks arguments and round-trips results', async () => {
    const echo = jsonGuard('t.echo', async (v: unknown) => v)
    expect(await echo({ a: 1 })).toEqual({ a: 1 })
    await expect(echo(new Date())).rejects.toThrow(/plain JSON/)
    const made = jsonGuard('t.make', async () => ({ when: new Date('2030-01-01T00:00:00Z') }))
    expect(await made()).toEqual({ when: '2030-01-01T00:00:00.000Z' })
  })
})

describe('checkSettingValue(field, value)', () => {
  const f = (over: object): SettingField =>
    ({ key: 'k', label: 'K', scope: 'space', ...over }) as SettingField
  /**
   * Inputs:   boolean, string (trimmed, with a max length), integer (with min and max), choice fields with good values
   * Expected: each accepted (text is trimmed)
   */
  it('accepts values that fit their field', () => {
    expect(checkSettingValue(f({ type: 'boolean', default: false }), true)).toBe(true)
    expect(checkSettingValue(f({ type: 'string', default: '', maxLength: 5 }), '  hi  ')).toBe('hi')
    expect(checkSettingValue(f({ type: 'integer', default: 1, min: 1, max: 10 }), 10)).toBe(10)
    expect(
      checkSettingValue(
        f({ type: 'choice', default: 'a', options: [{ value: 'a', label: 'A' }] }),
        'a',
      ),
    ).toBe('a')
  })
  /**
   * Inputs:   wrong types, an over-long string, integers outside the range or fractional, a choice that isn't an option
   * Expected: SettingError "invalid_setting" each time
   */
  it('refuses values that do not fit', () => {
    const bad = (field: SettingField, v: unknown) => () => checkSettingValue(field, v)
    expect(bad(f({ type: 'boolean', default: false }), 'yes')).toThrow(SettingError)
    expect(bad(f({ type: 'string', default: '', maxLength: 3 }), 'toolong')).toThrow(SettingError)
    expect(bad(f({ type: 'integer', default: 1, min: 1, max: 10 }), 11)).toThrow(SettingError)
    expect(bad(f({ type: 'integer', default: 1 }), 1.5)).toThrow(SettingError)
    expect(
      bad(f({ type: 'choice', default: 'a', options: [{ value: 'a', label: 'A' }] }), 'z'),
    ).toThrow(SettingError)
  })
})
