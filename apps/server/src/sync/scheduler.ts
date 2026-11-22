/**
 * Runs `run` on a schedule inside the server process: once shortly after start-up, then every
 * `intervalMs` (with a little random jitter). Runs never overlap, and a failure is logged and
 * the schedule carries on. SimpleFIN data generally refreshes about daily, so polling more often
 * gains nothing; the default is every 12 hours and the minimum is 4.
 */
export const MIN_INTERVAL_HOURS = 4
export const DEFAULT_INTERVAL_HOURS = 12

export const clampIntervalHours = (hours: number): number =>
  Number.isFinite(hours)
    ? Math.min(24, Math.max(MIN_INTERVAL_HOURS, hours))
    : DEFAULT_INTERVAL_HOURS

export function startSyncScheduler(opts: {
  run: () => Promise<unknown>
  intervalMs: number
  firstDelayMs?: number
  onError?: (e: unknown) => void
  /** 0..1, injectable for tests. */
  random?: () => number
}): { stop(): void } {
  const random = opts.random ?? Math.random
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let stopped = false

  const schedule = (delay: number) => {
    if (stopped) return
    timer = setTimeout(async () => {
      if (!running) {
        running = true
        try {
          await opts.run()
        } catch (e) {
          opts.onError?.(e)
        } finally {
          running = false
        }
      }
      schedule(opts.intervalMs * (0.95 + random() * 0.1))
    }, delay)
    timer.unref?.() // don't keep the process alive just for the schedule
  }
  schedule(opts.firstDelayMs ?? 60_000)

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
