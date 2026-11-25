/**
 * A stand-in for the database in backup and restore tests: a "database file" is a small JSON
 * document. The real SQLite version is checked in repos/backupDb.test.ts.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { BackupDb, DbInfo } from '../backup/types.js'

export interface FakeDbContent extends DbInfo {
  secrets: string[]
  broken?: boolean
  failsToMigrate?: boolean
}

export const fakeDbContent = (over: Partial<FakeDbContent> = {}): FakeDbContent => ({
  schemaVersion: 6,
  padMigrations: {},
  counts: { users: 1, spaces: 2, accounts: 3, transactions: 40 },
  secrets: [],
  ...over,
})

export interface FakeBackupDb extends BackupDb {
  /** What the next snapshot holds. */
  live: FakeDbContent
  /** Makes the next snapshots fail, like a full disk. */
  failSnapshot: boolean
}

export function createFakeBackupDb(live: FakeDbContent = fakeDbContent()): FakeBackupDb {
  const read = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8')) as FakeDbContent
  const db: FakeBackupDb = {
    live,
    failSnapshot: false,
    async snapshot(target) {
      if (db.failSnapshot) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      await fsp.writeFile(target, JSON.stringify(db.live), { mode: 0o600 })
    },
    inspect: (path) => read(path),
    integrityProblems: (path) => (read(path).broken ? ['broken'] : []),
    encryptedValues: (path) => read(path).secrets,
    latestSchemaVersion: () => 6,
    trialMigrate(path) {
      if (read(path).failsToMigrate) throw new Error('migration failed')
    },
  }
  return db
}
