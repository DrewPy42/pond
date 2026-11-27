/**
 * Restore while Pond is running: receive the file, unpack it into a staging folder, check
 * everything, and mark it ready. Nothing live is touched here; swap.ts does that at the next
 * start.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RestoreSummary } from '@pond/shared'
import { readArchive } from './archive.js'
import { checkDatabase, countUnreadableFiles } from './checks.js'
import { BackupError, isNoSpace } from './errors.js'
import { isFileEntry, type Manifest } from './manifest.js'
import type { BackupLock } from './lock.js'
import type { BackupPaths } from './paths.js'
import type { SafetyCopies } from './safety.js'
import { stagingDir, writeJournal } from './swap.js'
import type { BackupDb } from './types.js'

/** Room kept free on top of what a step needs. */
const SPARE_BYTES = 64 * 1024 * 1024

export interface RestoreDeps {
  db: BackupDb
  paths: BackupPaths
  lock: BackupLock
  safety: Pick<SafetyCopies, 'beforeRestore'>
  newId: () => string
  maxUploadBytes: number
  /** The LilyPads this version ships, with the migrations it knows. */
  shippedPads: () => Map<string, { name: string; migrations: string[] }>
  freeBytes?: (dir: string) => Promise<number>
}

export const diskFreeBytes = async (dir: string): Promise<number> => {
  const s = await fsp.statfs(dir)
  return s.bavail * s.bsize
}

export class RestoreService {
  private upload: { id: string; path: string; size: number } | null = null
  private staged: { id: string; summary: RestoreSummary } | null = null

  constructor(private d: RestoreDeps) {}

  private async requireRoom(bytes: number): Promise<void> {
    const free = await (this.d.freeBytes ?? diskFreeBytes)(this.d.paths.dataDir)
    if (free < bytes + SPARE_BYTES)
      throw new BackupError('not_enough_space', 'There is not enough free space for this restore.')
  }

  /** Drops any earlier upload and staged data. Only one restore is in progress at a time. */
  private async discard(): Promise<void> {
    this.upload = null
    this.staged = null
    await fsp.rm(this.d.paths.restoreDir, { recursive: true, force: true })
  }

  /** Streams an uploaded backup to disk. `declaredBytes` is the request's Content-Length. */
  async receive(source: Readable, declaredBytes: number): Promise<{ uploadId: string }> {
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0)
      throw new BackupError('upload_failed', 'The upload did not say how big it is.')
    if (declaredBytes > this.d.maxUploadBytes)
      throw new BackupError('too_large', 'That file is bigger than this Pond accepts.')
    const release = this.d.lock.acquire()
    try {
      await this.discard()
      // The upload itself, then its unpacked copy and a trial database.
      await this.requireRoom(declaredBytes * 3)
      const id = this.d.newId()
      const dir = path.join(this.d.paths.restoreDir, 'upload')
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      const target = path.join(dir, `${id}.pond`)
      try {
        await pipeline(source, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }))
        const size = (await fsp.stat(target)).size
        if (size !== declaredBytes) throw new BackupError('upload_failed', 'The upload stopped.')
        this.upload = { id, path: target, size }
      } catch (e) {
        await this.discard()
        if (isNoSpace(e)) throw new BackupError('not_enough_space')
        throw e instanceof BackupError ? e : new BackupError('upload_failed', 'The upload stopped.')
      }
      return { uploadId: id }
    } finally {
      release()
    }
  }

  /** Unpacks into staging and checks everything. A wrong passphrase keeps the upload. */
  async check(
    uploadId: string,
    passphrase: string,
    limits: { maxWorkFactor?: number } = {},
  ): Promise<RestoreSummary> {
    const release = this.d.lock.acquire()
    try {
      const upload = this.upload
      if (!upload || upload.id !== uploadId)
        throw new BackupError('restore_expired', 'Upload the backup file again.')
      this.staged = null
      const dir = stagingDir(this.d.paths, upload.id)
      await fsp.rm(dir, { recursive: true, force: true })
      await this.requireRoom(upload.size * 2)
      try {
        const summary = await this.stage(upload, dir, passphrase, limits.maxWorkFactor)
        this.staged = { id: upload.id, summary }
        return summary
      } catch (e) {
        await fsp.rm(dir, { recursive: true, force: true })
        if (isNoSpace(e)) throw new BackupError('not_enough_space')
        throw e
      }
    } finally {
      release()
    }
  }

  private async stage(
    upload: { id: string; path: string },
    dir: string,
    passphrase: string,
    maxWorkFactor: number | undefined,
  ): Promise<RestoreSummary> {
    await fsp.mkdir(path.join(dir, 'keys'), { recursive: true, mode: 0o700 })
    await fsp.mkdir(path.join(dir, 'files'), { mode: 0o700 })
    const manifest = await readArchive({
      source: upload.path,
      passphrase,
      maxWorkFactor,
      onManifest: (m) => this.checkVersions(m.schemaVersion, m.lilypads),
      sink: async (entry) => {
        // The path is one of the few shapes manifest.ts allows, so it stays inside `dir`.
        const to = path.join(dir, ...entry.path.split('/'))
        await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
        return fsp.open(to, 'wx', 0o600)
      },
    })

    const dbFile = path.join(dir, 'pond.db')
    const key = await fsp.readFile(path.join(dir, 'keys', 'master.key'))
    checkDatabase(this.d.db, dbFile, key)
    // The database is the truth about its own version, whatever the list says.
    const info = this.d.db.inspect(dbFile)
    this.checkVersions(info.schemaVersion, info.padMigrations)
    if (info.schemaVersion < 1)
      throw new BackupError('damaged_backup', 'The database in this backup is empty.')

    const trial = path.join(dir, 'trial.db')
    await fsp.copyFile(dbFile, trial)
    try {
      this.d.db.trialMigrate(trial)
    } catch {
      throw new BackupError('damaged_backup', "This backup's database can't be brought up to date.")
    } finally {
      for (const f of [trial, `${trial}-wal`, `${trial}-shm`]) await fsp.rm(f, { force: true })
    }

    const fileEntries = manifest.entries.map((e) => e.path).filter(isFileEntry)
    const unreadable = await countUnreadableFiles(fileEntries, path.join(dir, 'files'), key)
    if (unreadable > 0 && unreadable === fileEntries.length)
      throw new BackupError('key_mismatch', "The master key doesn't open this backup's files.")
    return this.summarize(manifest, info, fileEntries.length, unreadable)
  }

  private checkVersions(schemaVersion: number, pads: Record<string, string[]>): void {
    const shipped = this.d.shippedPads()
    const newer =
      schemaVersion > this.d.db.latestSchemaVersion() ||
      Object.entries(pads).some(([id, applied]) => {
        const known = shipped.get(id)
        return !!known && applied.some((name) => !known.migrations.includes(name))
      })
    if (newer)
      throw new BackupError(
        'newer_backup',
        'This backup was made by a newer Pond. Update Pond first.',
      )
  }

  private summarize(
    manifest: Manifest,
    info: { counts: Record<string, number>; padMigrations: Record<string, string[]> },
    files: number,
    unreadableFiles: number,
  ): RestoreSummary {
    const shipped = this.d.shippedPads()
    const n = (table: string) => info.counts[table] ?? 0
    const missingApps = Object.keys(info.padMigrations).filter((id) => !shipped.has(id))
    const warnings: string[] = []
    if (missingApps.length)
      warnings.push(
        `This Pond doesn't include these apps: ${missingApps.join(', ')}. Their information is restored and kept until a Pond that has them.`,
      )
    if (unreadableFiles)
      warnings.push(
        `${unreadableFiles} of ${files} uploaded files in this backup can't be opened. Everything else can be restored.`,
      )
    return {
      createdAt: manifest.createdAt,
      pondVersion: manifest.pondVersion,
      counts: {
        users: n('users'),
        spaces: n('spaces'),
        accounts: n('accounts'),
        transactions: n('transactions'),
        files,
      },
      warnings,
    }
  }

  /**
   * Takes a safety copy and marks the staged restore ready. The caller restarts Pond. After this,
   * the lock refuses everything else.
   */
  async confirm(uploadId: string, requestedBy: string | null): Promise<void> {
    const release = this.d.lock.acquire()
    try {
      const staged = this.staged
      if (!staged || staged.id !== uploadId)
        throw new BackupError('restore_expired', 'Check the backup file again.')
      await this.d.safety.beforeRestore()
      await fsp.rm(path.join(this.d.paths.restoreDir, 'upload'), { recursive: true, force: true })
      writeJournal(this.d.paths, {
        state: 'ready',
        id: staged.id,
        backupCreatedAt: staged.summary.createdAt,
        requestedBy,
      })
      this.d.lock.restorePending = true
    } finally {
      release()
    }
  }
}
