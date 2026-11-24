import { createMemoryPadStore } from './memoryStore'
import { tableStoreContract } from './storeContract'

// The in-memory store used by pad authors must obey the same contract as Pond's SQLite store.
tableStoreContract('memory store', () => {
  let n = 0
  let t = Date.parse('2030-01-15T12:00:00Z')
  return createMemoryPadStore({ newId: () => `id-${++n}`, now: () => new Date((t += 1000)) })
})
