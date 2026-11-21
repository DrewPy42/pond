/**
 * In-memory login throttling per key (IP and username are tracked separately by the caller).
 * After `freeAttempts` consecutive failures the key is locked for an exponentially growing
 * delay. State resets on restart, which is acceptable for a single-node home install.
 */
export interface LimiterOptions {
  freeAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Injectable clock (ms), for tests. */
  clock?: () => number
}

export class LoginLimiter {
  private readonly state = new Map<string, { failures: number; lockedUntil: number }>()
  private readonly free: number
  private readonly base: number
  private readonly max: number
  private readonly clock: () => number

  constructor(opts: LimiterOptions = {}) {
    this.free = opts.freeAttempts ?? 5
    this.base = opts.baseDelayMs ?? 30_000
    this.max = opts.maxDelayMs ?? 15 * 60_000
    this.clock = opts.clock ?? Date.now
  }

  /** Milliseconds the caller must still wait, or 0 if allowed. */
  retryAfterMs(key: string, now = this.clock()): number {
    const s = this.state.get(key)
    return s && s.lockedUntil > now ? s.lockedUntil - now : 0
  }

  /** Records a failure; returns true when this failure triggered a (new) lockout. */
  fail(key: string, now = this.clock()): boolean {
    const s = this.state.get(key) ?? { failures: 0, lockedUntil: 0 }
    s.failures += 1
    let locked = false
    if (s.failures >= this.free) {
      const delay = Math.min(this.base * 2 ** (s.failures - this.free), this.max)
      s.lockedUntil = now + delay
      locked = true
    }
    this.state.set(key, s)
    if (this.state.size > 10_000) this.prune(now)
    return locked
  }

  success(key: string): void {
    this.state.delete(key)
  }

  private prune(now: number): void {
    for (const [k, v] of this.state) if (v.lockedUntil < now - this.max) this.state.delete(k)
  }
}
