/**
 * Automatic safety copies, taken before a database change and before a restore
 * (docs/backup-design.md, "Safety copies"). They protect against a bad update, not a dead drive.
 * They are not encrypted: they sit beside the live database and key, and never leave the data
 * folder.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { BackupError } from './errors.js'
import { filePathOf, listFileEntries } from './files.js'
import type { GatedFileStore } from './fileGate.js'
import type { BackupPaths } from './paths.js'
import type { BackupDb } from './types.js'

export const SAFETY_KEEP = 5
export type SafetyKind = 'migration' | 'restore'

export interface SafetyCopies {
  /** Copies the database. Returns the new folder; throws if the copy can't be made. */
  beforeMigration(): Promise<string>
  /** Copies the database, master key and files. */
  beforeRestore(): Promise<string>
}

export function createSafetyCopies(o: {
  db: Pick<BackupDb, 'snapshot'>
  paths: BackupPaths
  now: () => Date
  gate?: Pick<GatedFileStore, 'hold'>
}): SafetyCopies {
  const take = async (kind: SafetyKind): Promise<string> => {
    const stamp = o.now().toISOString().replace(/[:.]/g, '-')
    const name = `${kind}-${stamp}-${randomBytes(3).toString('hex')}`
    const final = path.join(o.paths.safetyDir, name)
    const partial = `${final}.partial`
    const release = o.gate?.hold()
    try {
      await fs.mkdir(o.paths.safetyDir, { recursive: true, mode: 0o700 })
      await fs.mkdir(partial, { mode: 0o700 })
      await o.db.snapshot(path.join(partial, 'pond.db'))
      await fs.chmod(path.join(partial, 'pond.db'), 0o600)
      if (kind === 'restore') {
        await fs.mkdir(path.join(partial, 'keys'), { mode: 0o700 })
        await fs.writeFile(
          path.join(partial, 'keys', 'master.key'),
          await fs.readFile(o.paths.keyPath),
          { mode: 0o600 },
        )
        for (const entry of await listFileEntries(o.paths.filesDir)) {
          const to = path.join(partial, ...entry.split('/'))
          await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
          // Files are never edited in place, so a link is as good as a copy and takes no room.
          const from = filePathOf(o.paths.filesDir, entry)
          await fs.link(from, to).catch(() => fs.copyFile(from, to))
        }
      }
      await fs.rename(partial, final)
    } catch {
      await fs.rm(partial, { recursive: true, force: true }).catch(() => {})
      throw new BackupError(
        'safety_copy_failed',
        'Pond could not make a safety copy, so it did not go ahead. Check that the disk has room.',
      )
    } finally {
      release?.()
    }
    await prune(o.paths.safetyDir, kind)
    return final
  }
  return {
    beforeMigration: () => take('migration'),
    beforeRestore: () => take('restore'),
  }
}

/** Keeps the newest few of one kind. Failing to tidy up never fails the copy. */
async function prune(dir: string, kind: SafetyKind): Promise<void> {
  const pattern = new RegExp(`^${kind}-\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z-[0-9a-f]{6}$`)
  try {
    const mine = (await fs.readdir(dir)).filter((n) => pattern.test(n)).sort()
    for (const old of mine.slice(0, -SAFETY_KEEP))
      await fs.rm(path.join(dir, old), { recursive: true, force: true })
  } catch {
    /* left for next time */
  }
}
