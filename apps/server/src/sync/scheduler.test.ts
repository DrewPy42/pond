import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_INTERVAL_HOURS,
  MIN_INTERVAL_HOURS,
  clampIntervalHours,
  startSyncScheduler,
} from './scheduler'

describe('clampIntervalHours(hours)', () => {
  /**
   * Inputs:   1, 12, 48, NaN, undefined-as-NaN
   * Expected: 4 (never more often than every 4 hours), 12, 24 (at most daily), 12 (the default)
   *           for NaN
   */
  it('keeps the interval between 4 and 24 hours and defaults when unset', () => {
    expect(clampIntervalHours(1)).toBe(MIN_INTERVAL_HOURS)
    expect(clampIntervalHours(12)).toBe(12)
    expect(clampIntervalHours(48)).toBe(24)
    expect(clampIntervalHours(Number.NaN)).toBe(DEFAULT_INTERVAL_HOURS)
  })
})

describe('startSyncScheduler({ run, intervalMs, firstDelayMs })', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const HOUR = 3_600_000

  /**
   * Inputs:   firstDelayMs 1 minute, interval 12 hours, fixed jitter (random = 0.5, i.e. none)
   * Expected: nothing at start; runs once after 1 minute; then once per 12 hours
   */
  it('runs once shortly after start and then on the interval', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const s = startSyncScheduler({
      run,
      intervalMs: 12 * HOUR,
      firstDelayMs: 60_000,
      random: () => 0.5,
    })
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(12 * HOUR)
    expect(run).toHaveBeenCalledTimes(2)
    s.stop()
  })

  /**
   * Inputs:   a run that throws on every call
   * Expected: the error goes to onError and the schedule carries on (a bad day never stops syncing)
   */
  it('reports a failed run and keeps going', async () => {
    const onError = vi.fn()
    const run = vi.fn().mockRejectedValue(new Error('boom'))
    const s = startSyncScheduler({
      run,
      onError,
      intervalMs: HOUR,
      firstDelayMs: 1000,
      random: () => 0.5,
    })
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(run).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(2)
    s.stop()
  })

  /**
   * Inputs:   a run that takes longer than the interval
   * Expected: runs never overlap: a tick that arrives mid-run is skipped
   */
  it('never runs two syncs at once', async () => {
    let active = 0
    let maxActive = 0
    const run = vi.fn(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 3 * HOUR))
      active--
    })
    const s = startSyncScheduler({ run, intervalMs: HOUR, firstDelayMs: 0, random: () => 0.5 })
    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(maxActive).toBe(1)
    s.stop()
  })

  /**
   * Inputs:   stop() called before the first run, and again after some runs
   * Expected: no further runs happen
   */
  it('stops when asked', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const s = startSyncScheduler({ run, intervalMs: HOUR, firstDelayMs: 1000, random: () => 0.5 })
    s.stop()
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(run).not.toHaveBeenCalled()
  })
})
