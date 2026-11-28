/**
 * Counts sign-in attempts refused while an address is waiting. They would otherwise leave no
 * trace, so thousands of tries could look like a handful. One audit entry is written for each
 * address and waiting period, never one per attempt, so a flood can't fill the log. Nothing
 * that was typed is kept.
 *
 * Counts are held in memory until the wait is over. They are written when Pond stops normally;
 * a crash or power cut loses those not yet written (the lockout itself is already logged).
 */

export interface BlockedTally {
  /** Null stands for further addresses, once too many are being counted at once. */
  ip: string | null
  count: number
  firstAt: number
  lastAt: number
  /** When the wait these attempts ran into is over. */
  endsAt: number
}

/** More addresses than a home has. Beyond this they share one count, to bound memory. */
export const MAX_ADDRESSES = 500

export class BlockedAttempts {
  private readonly open = new Map<string | null, BlockedTally>()
  private done: BlockedTally[] = []

  constructor(private readonly maxAddresses = MAX_ADDRESSES) {}

  /** One refused attempt, with how long the address still has to wait. */
  note(address: string, waitMs: number, now: number): void {
    const known = this.open.has(address) || this.open.size < this.maxAddresses
    const ip = known ? address : null
    let tally = this.open.get(ip)
    // The earlier wait ended before this one began: that period is complete.
    if (tally && tally.endsAt <= now) {
      this.done.push(tally)
      tally = undefined
    }
    if (!tally) {
      this.open.set(ip, { ip, count: 1, firstAt: now, lastAt: now, endsAt: now + waitMs })
      return
    }
    tally.count += 1
    tally.lastAt = now
    tally.endsAt = Math.max(tally.endsAt, now + waitMs)
  }

  /** Removes and returns the periods that are over. */
  takeFinished(now: number): BlockedTally[] {
    const out = this.done
    this.done = []
    for (const [ip, tally] of this.open)
      if (tally.endsAt <= now) {
        out.push(tally)
        this.open.delete(ip)
      }
    return out
  }

  /** Removes and returns everything, finished or not, for when Pond is stopping. */
  takeAll(): BlockedTally[] {
    return this.takeFinished(Number.POSITIVE_INFINITY)
  }
}
