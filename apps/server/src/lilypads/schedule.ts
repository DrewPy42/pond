import type { Schedule } from '@pond/sdk'

/**
 * Structured schedules (docs/lilypad-contract.md, amendment A3): daily, weekly and monthly at a
 * local time. Pure functions; the clock and time zone are passed in.
 */
const AT = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Throws a readable error for a schedule a pad should not have registered. */
export function validateSchedule(s: Schedule): void {
  const kind = 'daily' in s ? s.daily : 'weekly' in s ? s.weekly : 'monthly' in s ? s.monthly : null
  if (!kind || typeof kind.at !== 'string' || !AT.test(kind.at))
    throw new Error('A schedule needs a time like "06:00"')
  if (
    'weekly' in s &&
    !(Number.isInteger(s.weekly.day) && s.weekly.day >= 0 && s.weekly.day <= 6)
  ) {
    throw new Error('Weekly day must be 0 (Sunday) to 6')
  }
  if (
    'monthly' in s &&
    !(Number.isInteger(s.monthly.day) && s.monthly.day >= 1 && s.monthly.day <= 28)
  ) {
    throw new Error('Monthly day must be 1 to 28 (so every month has it)')
  }
}

interface Local {
  y: number
  m: number
  d: number
  h: number
  min: number
  weekday: number
}
function localParts(date: Date, timeZone: string): Local {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  )
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!)
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    min: Number(parts.minute),
    weekday,
  }
}
/** The UTC instant at which the wall clock in `timeZone` reads the given local time. */
function instantFromLocal(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, h, min)
  const offsetAt = (t: number) => {
    const l = localParts(new Date(t), timeZone)
    return Date.UTC(l.y, l.m - 1, l.d, l.h, l.min) - Math.floor(t / 60000) * 60000
  }
  const first = guess - offsetAt(guess)
  return new Date(guess - offsetAt(first)) // second pass settles daylight-saving boundaries
}

/** The most recent time the schedule was due, at or before `now`. */
export function latestOccurrence(s: Schedule, now: Date, timeZone: string): Date {
  const kind = 'daily' in s ? s.daily : 'weekly' in s ? s.weekly : s.monthly
  const [h, min] = kind.at.split(':').map(Number) as [number, number]
  for (let back = 0; back <= 70; back++) {
    const l = localParts(new Date(now.getTime() - back * 86_400_000), timeZone)
    const dayMatches =
      'daily' in s ||
      ('weekly' in s && s.weekly.day === l.weekday) ||
      ('monthly' in s && s.monthly.day === l.d)
    if (!dayMatches) continue
    const occ = instantFromLocal(l.y, l.m, l.d, h, min, timeZone)
    if (occ.getTime() <= now.getTime()) return occ
  }
  throw new Error('No occurrence found')
}

/**
 * Should the job run now? First sighting (no last run) records "now" without running, so a pad
 * enabled mid-month doesn't surprise anyone; after that a run is due once an occurrence has passed
 * since the last run, which also catches up after downtime (one run, not one per missed occurrence).
 */
export function isDue(s: Schedule, lastRun: Date | null, now: Date, timeZone: string): boolean {
  if (!lastRun) return false
  return latestOccurrence(s, now, timeZone).getTime() > lastRun.getTime()
}
