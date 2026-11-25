/**
 * applyPendingRestore(paths) and rollbackRestore(paths): swapping a staged restore into place.
 * Plain files in a temp folder stand in for the database, key and files.
 */
import fs from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { readTree, tempDir, writeTree } from '../testing/backupWorld.js'
import { backupPaths } from './paths.js'
import {
  PowerCut,
  applyPendingRestore,
  readJournalFile,
  rollbackRestore,
  stagingDir,
  writeJournal,
} from './swap.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

const OLD = {
  'pond.db': 'old database',
  'pond.db-wal': 'old log',
  'pond.db-shm': 'old index',
  'keys/master.key': 'old key',
  'files/pad/s/1': 'old file',
}
const NEW = {
  'pond.db': 'new database',
  'keys/master.key': 'new key',
  'files/pad/s/2': 'new file',
}

async function ready(old: Record<string, string> = OLD) {
  const dir = await tempDir()
  made.push(dir)
  const paths = backupPaths(dir)
  await writeTree(dir, old)
  await writeTree(stagingDir(paths, 'r1'), NEW)
  writeJournal(paths, { state: 'ready', id: 'r1', backupCreatedAt: 'then', requestedBy: 'ann' })
  return paths
}

/** The live data only, as base64, ignoring the restore working folder. */
const live = async (dir: string) =>
  Object.fromEntries(Object.entries(await readTree(dir)).filter(([k]) => !k.startsWith('restore')))
const encoded = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')]))

/** Runs `fn`, cutting the power after its `n`th step. Returns false once there is no nth step. */
function cutAfter(n: number, fn: (step: () => void) => void): boolean {
  let count = 0
  try {
    fn(() => {
      if (++count === n) throw new PowerCut()
    })
    return false
  } catch (e) {
    if (e instanceof PowerCut) return true
    throw e
  }
}

describe('applyPendingRestore(paths)', () => {
  /**
   * Inputs:   no journal
   * Expected: "none", and the live data is untouched
   */
  it('does nothing when no restore is waiting', async () => {
    const dir = await tempDir()
    made.push(dir)
    await writeTree(dir, OLD)
    expect(applyPendingRestore(backupPaths(dir))).toEqual({ kind: 'none' })
    expect(await live(dir)).toEqual(encoded(OLD))
  })

  /**
   * Inputs:   a ready restore over an install with a database, its two side files, a key and a file
   * Expected: exactly the new data is live (the old database's side files are gone too)
   */
  it('replaces the database, key and files', async () => {
    const paths = await ready()
    expect(applyPendingRestore(paths)).toEqual({
      kind: 'swapped',
      info: { backupCreatedAt: 'then', requestedBy: 'ann' },
    })
    expect(await live(paths.dataDir)).toEqual(encoded(NEW))
    expect(readJournalFile(paths)!.state).toBe('swapped')
  })

  /**
   * Inputs:   the power cut after each step of the swap in turn, then a normal start
   * Expected: every time, the next start ends with exactly the new data, never a mixture
   */
  it('finishes the swap after a power cut at any step', async () => {
    let n = 1
    for (; ; n++) {
      const paths = await ready()
      if (!cutAfter(n, (step) => applyPendingRestore(paths, step))) break
      expect(applyPendingRestore(paths).kind, `cut at step ${n}`).toBe('swapped')
      expect(await live(paths.dataDir), `cut at step ${n}`).toEqual(encoded(NEW))
    }
    expect(n).toBeGreaterThan(8)
  })

  /**
   * Inputs:   a finished swap undone (the restored database would not open), with the power cut
   *           after each step of the undoing in turn; installs with and without side files
   * Expected: every time, the next start ends with exactly the old data
   */
  it('puts all the old data back, even if undoing is interrupted', async () => {
    const without = { 'pond.db': 'old database', 'keys/master.key': 'old key' }
    for (const old of [OLD, without]) {
      let n = 1
      for (; ; n++) {
        const paths = await ready(old)
        applyPendingRestore(paths)
        await writeTree(paths.dataDir, { 'pond.db-wal': 'made while trying the new database' })
        const cut = cutAfter(n, (step) => rollbackRestore(paths, step))
        if (cut) expect(applyPendingRestore(paths).kind).toBe('rolled_back')
        expect(await live(paths.dataDir), `cut at step ${n}`).toEqual(encoded(old))
        expect(readJournalFile(paths)).toBeNull()
        if (!cut) break
      }
      expect(n).toBeGreaterThan(4)
    }
  })

  /**
   * Inputs:   a swap interrupted halfway, then undone and interrupted at each step again
   * Expected: the old data comes back whole
   */
  it('can undo a half-finished swap', async () => {
    for (let n = 1; n <= 8; n++) {
      const paths = await ready()
      cutAfter(n, (step) => applyPendingRestore(paths, step))
      rollbackRestore(paths)
      expect(await live(paths.dataDir), `swap cut at step ${n}`).toEqual(encoded(OLD))
    }
  })

  /**
   * Inputs:   a ready journal whose staged database is missing
   * Expected: "rolled_back" with the old data untouched
   */
  it('abandons a restore whose staged data is incomplete', async () => {
    const paths = await ready()
    await fs.rm(`${stagingDir(paths, 'r1')}/pond.db`)
    expect(applyPendingRestore(paths).kind).toBe('rolled_back')
    expect(await live(paths.dataDir)).toEqual(encoded(OLD))
  })
})
