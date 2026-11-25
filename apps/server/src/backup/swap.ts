/**
 * Putting a staged restore in place, before the database is opened (docs/backup-design.md,
 * "Restore"). Everything is a rename inside the data folder, and a journal records how far it got.
 * After a power cut, the next start finishes the swap, or finishes undoing it. The old data stays
 * in `restore/old` until the restored database has opened and migrated.
 *
 * Synchronous on purpose: nothing else may run while this does.
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { BackupPaths } from './paths.js'

/** In swap order. The database's side files must go with the old database, never the new one. */
const ITEMS = ['pond.db-wal', 'pond.db-shm', 'pond.db', 'keys/master.key', 'files'] as const
type Item = (typeof ITEMS)[number]

const journalSchema = z.object({
  state: z.enum(['ready', 'swapping', 'swapped', 'rolling_back']),
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  backupCreatedAt: z.string(),
  requestedBy: z.string().nullable(),
  /** Which live items existed before the swap, so undoing it is exact. */
  had: z.partialRecord(z.enum(ITEMS), z.boolean()).optional(),
})
export type Journal = z.infer<typeof journalSchema>
export type RestoreInfo = Pick<Journal, 'backupCreatedAt' | 'requestedBy'>

export const journalPath = (p: BackupPaths) => path.join(p.restoreDir, 'journal.json')
export const stagingDir = (p: BackupPaths, id: string) => path.join(p.restoreDir, 'staging', id)
const oldDir = (p: BackupPaths) => path.join(p.restoreDir, 'old')

const syncDir = (dir: string): void => {
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function writeJournal(p: BackupPaths, journal: Journal): void {
  fs.mkdirSync(p.restoreDir, { recursive: true, mode: 0o700 })
  const temp = `${journalPath(p)}.tmp`
  fs.writeFileSync(temp, JSON.stringify(journal), { mode: 0o600, flush: true })
  fs.renameSync(temp, journalPath(p))
  syncDir(p.restoreDir)
}

export function readJournalFile(p: BackupPaths): Journal | null {
  let raw: string
  try {
    raw = fs.readFileSync(journalPath(p), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  // A journal that can't be understood stops the start: guessing could destroy data.
  return journalSchema.parse(JSON.parse(raw))
}

/** Lets tests cut the power between any two steps. */
export type Step = (name: string) => void

function move(from: string, to: string, step: Step): void {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
  fs.renameSync(from, to)
  syncDir(path.dirname(to))
  syncDir(path.dirname(from))
  step(`moved ${to}`)
}

const places = (p: BackupPaths, journal: Journal, item: Item) => ({
  live: path.join(p.dataDir, item),
  staged: path.join(stagingDir(p, journal.id), item),
  old: path.join(oldDir(p), item),
})
const isStagedItem = (item: Item) => !item.startsWith('pond.db-')

function forward(p: BackupPaths, journal: Journal, step: Step): void {
  for (const item of ITEMS) {
    const at = places(p, journal, item)
    const incoming = isStagedItem(item) && fs.existsSync(at.staged)
    // Already done: the staged item has moved in (or there was nothing to bring).
    if (isStagedItem(item) && !incoming) continue
    if (fs.existsSync(at.live) && !fs.existsSync(at.old)) move(at.live, at.old, step)
    if (incoming) move(at.staged, at.live, step)
  }
}

function backward(p: BackupPaths, journal: Journal, step: Step): void {
  for (const item of [...ITEMS].reverse()) {
    const at = places(p, journal, item)
    const had = journal.had?.[item] === true
    const hasOld = fs.existsSync(at.old)
    // Anything live that came from staging goes back there.
    if (isStagedItem(item) && !fs.existsSync(at.staged) && fs.existsSync(at.live)) {
      if (hasOld || !had) move(at.live, at.staged, step)
    }
    if (hasOld) {
      fs.rmSync(at.live, { recursive: true, force: true }) // side files a new database made
      move(at.old, at.live, step)
    } else if (!had && !isStagedItem(item)) {
      fs.rmSync(at.live, { force: true })
    }
  }
}

export type SwapResult =
  | { kind: 'none' }
  | { kind: 'swapped'; info: RestoreInfo }
  | { kind: 'rolled_back'; info: RestoreInfo }

const infoOf = (j: Journal): RestoreInfo => ({
  backupCreatedAt: j.backupCreatedAt,
  requestedBy: j.requestedBy,
})

/** Puts the old data back. Safe to call again if it was interrupted. */
export function rollbackRestore(p: BackupPaths, step: Step = () => {}): SwapResult {
  const journal = readJournalFile(p)
  if (!journal) return { kind: 'none' }
  const rolling: Journal = { ...journal, state: 'rolling_back' }
  writeJournal(p, rolling)
  step('rolling back')
  backward(p, rolling, step)
  clearRestore(p)
  return { kind: 'rolled_back', info: infoOf(journal) }
}

/** Run at start-up, before the database or key is opened. */
export function applyPendingRestore(p: BackupPaths, step: Step = () => {}): SwapResult {
  let journal = readJournalFile(p)
  if (!journal) return { kind: 'none' }
  if (journal.state === 'rolling_back') return rollbackRestore(p, step)
  if (journal.state === 'swapped') return { kind: 'swapped', info: infoOf(journal) }
  if (journal.state === 'ready') {
    const staged = stagingDir(p, journal.id)
    if (
      !['pond.db', 'keys/master.key', 'files'].every((i) => fs.existsSync(path.join(staged, i)))
    ) {
      clearRestore(p) // nothing has been touched
      return { kind: 'rolled_back', info: infoOf(journal) }
    }
    fs.rmSync(oldDir(p), { recursive: true, force: true })
    journal = {
      ...journal,
      state: 'swapping',
      had: Object.fromEntries(ITEMS.map((i) => [i, fs.existsSync(path.join(p.dataDir, i))])),
    }
    writeJournal(p, journal)
    step('swapping')
  }
  try {
    forward(p, journal, step)
  } catch (e) {
    if (e instanceof PowerCut) throw e
    return rollbackRestore(p, step)
  }
  writeJournal(p, { ...journal, state: 'swapped' })
  step('swapped')
  return { kind: 'swapped', info: infoOf(journal) }
}

/** Thrown by tests through `step` to stop dead, as a power cut would. */
export class PowerCut extends Error {}

/** Removes the journal first, so what follows can never be mistaken for an unfinished restore. */
export function clearRestore(p: BackupPaths): void {
  fs.rmSync(journalPath(p), { force: true })
  fs.rmSync(p.restoreDir, { recursive: true, force: true })
}
