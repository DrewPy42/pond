import { openDb, runMigrations } from '../db/index'
import { createDrizzleRepos } from './drizzle'
import { repoContract } from '../testing/repoContract'

// One of the only places a real database appears: proving the real repositories obey the
// contract (and so match the fakes). Each test gets a fresh in-memory SQLite database.
repoContract('drizzle repos (SQLite)', () => {
  const handle = openDb(':memory:')
  runMigrations(handle)
  return createDrizzleRepos(handle)
})
