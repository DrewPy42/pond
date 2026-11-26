/** The SQLite side of backup and restore (backup/types.ts). */
import Database from 'better-sqlite3'
import { latestSchemaVersion, openDb, runMigrations, type DbHandle } from '../db/index.js'
import type { BackupDb } from '../backup/types.js'

/** Settings whose value is encrypted with the master key. */
const ENCRYPTED_SETTINGS = ['backup.passphrase', 'backup.remote']

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`

/** Opens a database file that came from a backup: read only, and nothing in it is trusted. */
function withFile<T>(path: string, fn: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    db.pragma('trusted_schema = OFF')
    return fn(db)
  } finally {
    db.close()
  }
}

const tables = (db: Database.Database): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name)

/** `live` is the open database; it is only needed to take snapshots. */
export function createSqliteBackupDb(live: DbHandle | null): BackupDb {
  return {
    async snapshot(target) {
      if (!live) throw new Error('No open database to copy')
      await live.sqlite.backup(target)
    },
    inspect(path) {
      return withFile(path, (db) => {
        const names = tables(db)
        const counts: Record<string, number> = {}
        for (const t of names)
          counts[t] = (db.prepare(`SELECT count(*) AS n FROM ${quote(t)}`).get() as { n: number }).n
        const padMigrations: Record<string, string[]> = {}
        if (names.includes('lilypad_migrations')) {
          const rows = db
            .prepare('SELECT pad_id, name FROM lilypad_migrations ORDER BY pad_id, name')
            .all() as { pad_id: string; name: string }[]
          for (const r of rows) (padMigrations[r.pad_id] ??= []).push(r.name)
        }
        return { schemaVersion: counts.__drizzle_migrations ?? 0, padMigrations, counts }
      })
    },
    integrityProblems(path) {
      try {
        return withFile(path, (db) => {
          const integrity = (db.pragma('integrity_check') as { integrity_check: string }[])
            .map((r) => r.integrity_check)
            .filter((r) => r !== 'ok')
          const foreign = (db.pragma('foreign_key_check') as { table: string }[]).map(
            (r) => `broken reference in ${r.table}`,
          )
          return [...integrity, ...foreign]
        })
      } catch {
        return ['the database could not be read']
      }
    },
    *encryptedValues(path) {
      const values = withFile(path, (db) => {
        const out: string[] = []
        const names = tables(db)
        for (const t of names) {
          const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(t) as {
            name: string
          }[]
          for (const c of columns.filter((x) => x.name.endsWith('_enc'))) {
            const rows = db
              .prepare(
                `SELECT ${quote(c.name)} AS v FROM ${quote(t)} WHERE ${quote(c.name)} IS NOT NULL`,
              )
              .all() as { v: unknown }[]
            for (const r of rows) out.push(String(r.v))
          }
        }
        if (names.includes('settings')) {
          const stmt = db.prepare('SELECT value FROM settings WHERE key = ?')
          for (const key of ENCRYPTED_SETTINGS)
            for (const r of stmt.all(key) as { value: string }[])
              out.push(String(JSON.parse(r.value)))
        }
        return out
      })
      yield* values
    },
    latestSchemaVersion: () => latestSchemaVersion(),
    trialMigrate(path) {
      const handle = openDb(path)
      try {
        runMigrations(handle)
      } finally {
        handle.close()
      }
    },
  }
}
