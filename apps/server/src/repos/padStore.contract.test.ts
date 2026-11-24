import { tableStoreContract } from '@pond/sdk/testing/contract'
import { openDb } from '../db/index'
import { createSqlitePadStore } from './padStore'

// The SQLite store must obey the same table-API contract as the in-memory store pad authors test
// against. Real SQLite on purpose: this is the one place the table API meets the database.
tableStoreContract('sqlite pad store', () => {
  const handle = openDb(':memory:')
  let n = 0
  let t = Date.parse('2030-01-15T12:00:00Z')
  return createSqlitePadStore(handle.sqlite, {
    newId: () => `id-${++n}`,
    now: () => new Date((t += 1000)),
  })
})
