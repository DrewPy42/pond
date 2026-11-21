import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema.js'

export type Db = BetterSQLite3Database<typeof schema>
export interface DbHandle {
  db: Db
  sqlite: Database.Database
  close(): void
}

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
)

/** Open SQLite with the Pi-friendly pragmas: WAL, enforced foreign keys, sane busy timeout. */
export function openDb(dbPath: string): DbHandle {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  return { db: drizzle(sqlite, { schema }), sqlite, close: () => sqlite.close() }
}

/** Forward-only: applies pending migrations, never rolls back (CLAUDE.md rule 9). */
export function runMigrations(handle: DbHandle, dir = MIGRATIONS_DIR): void {
  migrate(handle.db, { migrationsFolder: dir })
}

/** Number of applied migrations, reported by /api/health as the schema version. */
export function schemaVersion(handle: DbHandle): number {
  const row = handle.sqlite
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    )
    .get() as { n: number }
  if (row.n === 0) return 0
  const r = handle.sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as {
    n: number
  }
  return r.n
}
