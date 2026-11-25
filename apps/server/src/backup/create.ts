import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readArchive, sha256File, writeArchive } from './archive.js'
import { checkDatabase } from './checks.js'
import { BackupError, isNoSpace } from './errors.js'
import { filePathOf, listFileEntries } from './files.js'
import type { GatedFileStore } from './fileGate.js'
import { DB_PATH, FORMAT_VERSION, KEY_PATH, type Manifest, type ManifestEntry } from './manifest.js'
import type { BackupPaths } from './paths.js'
import type { BackupDb } from './types.js'

export interface CreateOptions {
  db: BackupDb
  paths: BackupPaths
  gate: Pick<GatedFileStore, 'hold'>
  passphrase: string
  workFactor: number
  instanceId: string
  pondVersion: string
  createdAt: Date
  /** The finished file. It only appears under this name once it has been checked. */
  target: string
}

/** Snapshot, collect, encrypt, then read the result back and verify every checksum. */
export async function createBackupFile(o: CreateOptions): Promise<{ bytes: number }> {
  const partial = `${o.target}.${randomBytes(4).toString('hex')}.partial`
  await fs.mkdir(o.paths.tmpDir, { recursive: true, mode: 0o700 })
  const work = await fs.mkdtemp(path.join(o.paths.tmpDir, 'backup-'))
  const release = o.gate.hold() // before the snapshot, so nothing it refers to can go
  try {
    const dbCopy = path.join(work, 'pond.db')
    await o.db.snapshot(dbCopy)
    const keyCopy = path.join(work, 'master.key')
    await fs.writeFile(keyCopy, await fs.readFile(o.paths.keyPath), { mode: 0o600 })
    checkDatabase(o.db, dbCopy, await fs.readFile(keyCopy))
    const info = o.db.inspect(dbCopy)

    const sourceOf = (e: { path: string }): string =>
      e.path === DB_PATH
        ? dbCopy
        : e.path === KEY_PATH
          ? keyCopy
          : filePathOf(o.paths.filesDir, e.path)
    const entries: ManifestEntry[] = []
    for (const p of [DB_PATH, KEY_PATH, ...(await listFileEntries(o.paths.filesDir))])
      entries.push({ path: p, ...(await sha256File(sourceOf({ path: p }))) })

    const manifest: Manifest = {
      app: 'pond',
      format: FORMAT_VERSION,
      pondVersion: o.pondVersion,
      schemaVersion: info.schemaVersion,
      lilypads: info.padMigrations,
      instanceId: o.instanceId,
      createdAt: o.createdAt.toISOString(),
      counts: info.counts,
      entries,
    }
    await writeArchive({
      target: partial,
      passphrase: o.passphrase,
      workFactor: o.workFactor,
      manifest,
      sourceOf,
    })
    await readArchive({ source: partial, passphrase: o.passphrase })
    await fs.rename(partial, o.target)
    return { bytes: (await fs.stat(o.target)).size }
  } catch (e) {
    if (isNoSpace(e)) throw new BackupError('not_enough_space')
    throw e
  } finally {
    release()
    await fs.rm(partial, { force: true })
    await fs.rm(work, { recursive: true, force: true })
  }
}
