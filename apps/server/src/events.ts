import type { PadEvent } from '@pond/sdk'

/**
 * A small in-process event bus. Core services emit events AFTER the data change has been
 * committed; listeners (the LilyPad host) run later, one at a time, and a failing listener never
 * affects the operation that triggered the event or any other listener.
 */
export interface EventBus {
  emit(event: PadEvent): void
  /** Subscribes to every event. Returns an unsubscribe function. */
  subscribe(listener: (event: PadEvent) => Promise<void> | void): () => void
  /** Resolves when every queued event has been delivered (for tests and orderly shutdown). */
  whenIdle(): Promise<void>
}

export function createEventBus(onError?: (error: unknown, event: PadEvent) => void): EventBus {
  const listeners = new Set<(event: PadEvent) => Promise<void> | void>()
  const queue: PadEvent[] = []
  let draining: Promise<void> | null = null

  const drain = async () => {
    while (queue.length > 0) {
      const event = queue.shift()!
      for (const l of [...listeners]) {
        try {
          await l(event)
        } catch (e) {
          onError?.(e, event)
        }
      }
    }
    draining = null
  }

  return {
    emit(event) {
      queue.push(event)
      draining ??= Promise.resolve().then(drain)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    async whenIdle() {
      while (draining) await draining
    },
  }
}

/** Distinct Space ids, for emitting one event per Space a transaction touches. */
export const distinct = (ids: readonly string[]): string[] => [...new Set(ids)]
