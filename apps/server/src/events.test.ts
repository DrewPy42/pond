import type { PadEvent } from '@pond/sdk'
import { describe, expect, it } from 'vitest'
import { createEventBus } from './events'

const ev = (n: number): PadEvent => ({
  type: 'transaction.created',
  spaceId: 's',
  transactionId: `t${n}`,
})

describe('createEventBus()', () => {
  /**
   * Function: emit, subscribe, whenIdle
   * Inputs:   two listeners; three events emitted synchronously
   * Expected: nothing is delivered during emit (the caller isn't blocked); after whenIdle every listener has seen all
   *           three events in order
   */
  it('delivers every event to every listener, in order, after the emitter returns', async () => {
    const bus = createEventBus()
    const a: string[] = []
    const b: string[] = []
    bus.subscribe((e) => void a.push((e as { transactionId: string }).transactionId))
    bus.subscribe((e) => void b.push((e as { transactionId: string }).transactionId))
    bus.emit(ev(1))
    bus.emit(ev(2))
    bus.emit(ev(3))
    expect(a).toEqual([])
    await bus.whenIdle()
    expect(a).toEqual(['t1', 't2', 't3'])
    expect(b).toEqual(['t1', 't2', 't3'])
  })
  /**
   * Function: error isolation
   * Inputs:   a listener that throws, followed by a healthy one; an onError callback
   * Expected: the healthy listener still gets every event; onError is told about each failure
   */
  it('isolates a failing listener', async () => {
    const errors: unknown[] = []
    const bus = createEventBus((e) => errors.push(e))
    const seen: string[] = []
    bus.subscribe(() => {
      throw new Error('boom')
    })
    bus.subscribe((e) => void seen.push(e.type))
    bus.emit(ev(1))
    bus.emit(ev(2))
    await bus.whenIdle()
    expect(seen).toHaveLength(2)
    expect(errors).toHaveLength(2)
  })
  /**
   * Function: subscribe's unsubscribe
   * Inputs:   a listener removed before an event is emitted
   * Expected: it receives nothing
   */
  it('stops delivering after unsubscribe', async () => {
    const bus = createEventBus()
    const seen: string[] = []
    const off = bus.subscribe((e) => void seen.push(e.type))
    off()
    bus.emit(ev(1))
    await bus.whenIdle()
    expect(seen).toEqual([])
  })
})
