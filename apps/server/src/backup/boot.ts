/**
 * Opening the database at start-up: finish any restore that is waiting, take a safety copy before
 * migrating existing data, and put the old data back if the restored database won't open.
 */
import fs from 'node:fs/promises'
import { compactIfAsked, openDb, runMigrations, schemaVersion, type DbHandle } from '../db/index.js'
import { createSqliteBackupDb } from '../repos/backupDb.js'
import type { Repos } from '../repos/types.js'
import { recordAudit } from '../audit.js'
import type { BackupPaths } from './paths.js'
import { createSafetyCopies } from './safety.js'
import { resetStatusAfterRestore } from './settings.js'
import { applyPendingRestore, clearRestore, rollbackRestore, type SwapResult } from './swap.js'

export interface Booted {
  db: DbHandle
  restore: SwapResult
  /** A safety copy was made before migrating; pad migrations in this start don't need another. */
  safetyCopyTaken: boolean
  /** A cleanup a migration asked for didn't work. Pond runs, and tries again next start. */
  cleanupFailed: boolean
}

export async function bootDatabase(
  paths: BackupPaths,
  now: () => Date = () => new Date(),
  migrate: (db: DbHandle) => void = runMigrations,
  compact: (db: DbHandle) => void = compactIfAsked,
): Promise<Booted> {
  let restore = applyPendingRestore(paths)
  await fs.rm(paths.tmpDir, { recursive: true, force: true })
  if (restore.kind === 'none') await fs.rm(paths.restoreDir, { recursive: true, force: true })

  const open = async (): Promise<Booted> => {
    const db = openDb(paths.dbPath)
    try {
      const version = schemaVersion(db)
      const safetyCopyTaken =
        version > 0 && version < createSqliteBackupDb(db).latestSchemaVersion()
      if (safetyCopyTaken)
        await createSafetyCopies({ db: createSqliteBackupDb(db), paths, now }).beforeMigration()
      migrate(db)
      let cleanupFailed = false
      try {
        compact(db)
      } catch {
        // Not a reason to keep Pond from starting, or to undo a restore.
        cleanupFailed = true
      }
      return { db, restore, safetyCopyTaken, cleanupFailed }
    } catch (e) {
      db.close()
      throw e
    }
  }

  try {
    return await open()
  } catch (e) {
    if (restore.kind !== 'swapped') throw e
    restore = rollbackRestore(paths)
    return open()
  }
}

/** Once the repositories exist: sign everyone out, record what happened and tidy up. */
export function finishRestore(
  restore: SwapResult,
  d: { repos: Repos; paths: BackupPaths; now: () => Date; newId: () => string },
): void {
  if (restore.kind === 'none') return
  const done = restore.kind === 'swapped'
  d.repos.transaction(() => {
    if (done) {
      d.repos.sessions.deleteAll()
      resetStatusAfterRestore(d.repos.settings, d.now())
    }
    recordAudit(
      d.repos.audit,
      {
        actorType: 'system',
        action: done ? 'backup.restored' : 'backup.restore_failed',
        meta: { ...restore.info },
      },
      d.now(),
      d.newId,
    )
  })
  if (done) clearRestore(d.paths)
}
