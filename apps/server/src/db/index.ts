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

/**
 * Rebuilds the database file if a migration asked for it, so that text it removed doesn't stay
 * in unused parts of the file, which backups would copy. SQLite can't do this inside a
 * migration. The request is only cleared once the rebuild has worked, so a power cut or a full
 * drive means it is tried again at the next start.
 */
export function compactIfAsked({ sqlite }: DbHandle): boolean {
  const request =
    "FROM settings WHERE scope = 'global' AND scope_id = '' AND key = 'system.compactNeeded'"
  if (!sqlite.prepare(`SELECT 1 ${request}`).get()) return false
  sqlite.exec('VACUUM')
  sqlite.prepare(`DELETE ${request}`).run()
  // Last: this also empties the write-ahead log, where the old pages were.
  sqlite.pragma('wal_checkpoint(TRUNCATE)')
  return true
}

interface JournalEntry {
  idx: number
  tag: string
}

export function readJournal(dir = MIGRATIONS_DIR): JournalEntry[] {
  const raw = fs.readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries
}

/** Number of migrations that ship today. Each one is one "schema version". */
export const latestSchemaVersion = (): number => readJournal().length

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
