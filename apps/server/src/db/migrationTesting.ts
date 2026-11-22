import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MIGRATIONS_DIR, runMigrations, type DbHandle } from './index.js'

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

/**
 * Bring a database to exactly `version` (1 = only the first migration applied), the way an
 * install running an older release would look. A later `runMigrations(handle)` then performs
 * the real upgrade path. Copies the first `version` migrations into a temp folder.
 */
export function migrateToVersion(handle: DbHandle, version: number): void {
  const entries = readJournal().slice(0, version)
  if (entries.length !== version) throw new RangeError(`No schema version ${version}`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-migrations-'))
  try {
    fs.mkdirSync(path.join(tmp, 'meta'))
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
    )
    journal.entries = entries
    fs.writeFileSync(path.join(tmp, 'meta', '_journal.json'), JSON.stringify(journal))
    for (const e of entries) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(tmp, `${e.tag}.sql`))
    }
    runMigrations(handle, tmp)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
