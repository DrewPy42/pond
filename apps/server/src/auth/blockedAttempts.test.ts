import { describe, expect, it } from 'vitest'
import { BlockedAttempts } from './blockedAttempts'

describe('BlockedAttempts', () => {
  /**
   * Inputs:   an address blocked twice in one 30 s wait, then, after that wait ended and before
   *           anything was collected, blocked again in a new wait
   * Expected: two separate periods, so a steady attack gives one entry per wait instead of one
   *           that never ends
   */
  it('keeps each waiting period separate', () => {
    const b = new BlockedAttempts()
    b.note('a', 30_000, 0)
    b.note('a', 25_000, 5_000)
    b.note('a', 60_000, 40_000)
    expect(b.takeFinished(45_000)).toEqual([
      { ip: 'a', count: 2, firstAt: 0, lastAt: 5_000, endsAt: 30_000 },
    ])
    expect(b.takeFinished(100_000)).toEqual([
      { ip: 'a', count: 1, firstAt: 40_000, lastAt: 40_000, endsAt: 100_000 },
    ])
  })

  /**
   * Inputs:   two addresses with different waits, collected part-way through, then everything
   * Expected: only finished waits are returned, each once; takeAll returns the unfinished too
   */
  it('returns finished periods once, and everything when stopping', () => {
    const b = new BlockedAttempts()
    b.note('a', 1_000, 0)
    b.note('b', 90_000, 0)
    expect(b.takeFinished(2_000).map((t) => t.ip)).toEqual(['a'])
    expect(b.takeFinished(2_000)).toEqual([])
    expect(b.takeAll().map((t) => t.ip)).toEqual(['b'])
    expect(b.takeAll()).toEqual([])
  })

  /**
   * Inputs:   room for two addresses, and attempts from four
   * Expected: the extra ones share one count with no address, so memory can't grow without
   *           limit and no attempt goes uncounted
   */
  it('shares one count between addresses beyond its limit', () => {
    const b = new BlockedAttempts(2)
    for (const ip of ['a', 'b', 'c', 'd', 'a', 'c']) b.note(ip, 1_000, 0)
    expect(b.takeAll().map((t) => [t.ip, t.count])).toEqual([
      ['a', 2],
      ['b', 1],
      [null, 3],
    ])
  })
})
