/** Making backups: passphrase, destinations, schedule, retention and warnings. */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Schedule } from '@pond/sdk'
import type { BackupSchedule, BackupView, BackupWarning } from '@pond/shared'
import { recordAudit } from '../audit.js'
import type { Crypto } from '../crypto/index.js'
import { isDue } from '../lilypads/schedule.js'
import type { Repos } from '../repos/types.js'
import { createBackupFile } from './create.js'
import { BackupError } from './errors.js'
import type { GatedFileStore } from './fileGate.js'
import type { BackupLock } from './lock.js'
import type { BackupPaths } from './paths.js'
import {
  KEYS,
  readFolderEnabled,
  readKeep,
  readPassphraseEnc,
  readSchedule,
  readStatus,
  writeStatus,
  type ScheduledRun,
} from './settings.js'
import type { BackupDb } from './types.js'

export const MIN_PASSPHRASE_LENGTH = 12
/** Written into the backup folder. If it's gone, the drive or share isn't there. */
export const MARKER_FILE = '.pond-backup-folder'
type Destination = 'folder' | 'download'
type Weekday = Extract<Schedule, { weekly: unknown }>['weekly']['day']
const DOWNLOAD_LIFETIME_MS = 15 * 60_000
const DAY_MS = 86_400_000
/** How old the newest good backup may get before admins are warned. */
const STALE_AFTER_MS = { daily: 3 * DAY_MS, weekly: 10 * DAY_MS }

export interface BackupDeps {
  repos: Repos
  crypto: Crypto
  db: BackupDb
  paths: BackupPaths
  gate: Pick<GatedFileStore, 'hold'>
  lock: BackupLock
  now: () => Date
  newId: () => string
  timeZone: string
  pondVersion: string
  workFactor: number
}

export interface Download {
  path: string
  filename: string
}

export class BackupService {
  /** Finished backups waiting to be fetched, tied to the session that made them. */
  private downloads = new Map<string, Download & { sessionId: string; expiresAt: number }>()
  private running = false

  constructor(private d: BackupDeps) {}

  private audit(actorId: string | null, action: string, meta?: Record<string, unknown>): void {
    recordAudit(this.d.repos.audit, { actorId, action, meta }, this.d.now(), this.d.newId)
  }

  /** Identifies this install's own files, so tidying up never touches anyone else's. */
  private instanceId(): string {
    const stored = this.d.repos.settings.get('global', '', KEYS.instanceId)
    if (typeof stored === 'string') return stored
    const id = randomBytes(6).toString('hex')
    this.d.repos.settings.set('global', '', KEYS.instanceId, id)
    return id
  }

  private async folderAvailable(): Promise<boolean> {
    if (!this.d.paths.folderDir) return false
    return fs.stat(this.d.paths.folderDir).then(
      (s) => s.isDirectory(),
      () => false,
    )
  }

  private async markerPresent(): Promise<boolean> {
    if (!this.d.paths.folderDir) return false
    return fs.stat(path.join(this.d.paths.folderDir, MARKER_FILE)).then(
      (s) => s.isFile(),
      () => false,
    )
  }

  async view(): Promise<BackupView> {
    const { settings } = this.d.repos
    const status = readStatus(settings)
    const enabled = readFolderEnabled(settings)
    return {
      passphraseSet: readPassphraseEnc(settings) !== null,
      schedule: readSchedule(settings),
      keep: readKeep(settings),
      folder: {
        path: this.d.paths.folderDir,
        available: await this.folderAvailable(),
        enabled,
        connected: enabled && (await this.markerPresent()),
      },
      lastFolderBackupAt: status.folderSuccessAt ?? null,
      lastDownloadAt: status.downloadSuccessAt ?? null,
      running: this.running,
      restorePending: this.d.lock.restorePending,
      warnings: this.warnings(),
    }
  }

  /**
   * For a schedule that is on: nowhere to save to, or the folder failing or falling behind. A
   * backup that fails unnoticed is the real risk.
   */
  warnings(): BackupWarning[] {
    const { settings } = this.d.repos
    const schedule = readSchedule(settings)
    if (!schedule.enabled) return []
    // An install that only used online storage gets here once that was removed.
    if (!readFolderEnabled(settings)) return [{ kind: 'no_destination' }]
    const s = readStatus(settings)
    const success = s.folderSuccessAt
    const last = s.lastScheduled?.folder
    if (last && !last.ok && !(success && success > last.at))
      return [{ kind: 'failed', at: last.at, reason: last.reason ?? 'backup_failed' }]
    const since = success ?? s.since?.folder
    if (since && this.d.now().getTime() - Date.parse(since) > STALE_AFTER_MS[schedule.frequency])
      return [{ kind: 'stale', lastSuccessAt: success ?? null }]
    return []
  }

  /** A folder that was just turned on is judged from now, not from its past. */
  private startCounting(): void {
    writeStatus(this.d.repos.settings, {
      since: { folder: this.d.now().toISOString() },
      lastScheduled: {},
    })
  }

  /** The passphrase is stored encrypted, never shown again and never logged or audited. */
  setPassphrase(actorId: string, passphrase: string): void {
    if ([...passphrase].length < MIN_PASSPHRASE_LENGTH)
      throw new BackupError('weak_passphrase', 'Use at least 12 characters.')
    const changed = readPassphraseEnc(this.d.repos.settings) !== null
    this.d.repos.settings.set('global', '', KEYS.passphrase, this.d.crypto.encrypt(passphrase))
    this.audit(actorId, 'backup.settings_changed', { setting: changed ? 'changed' : 'first set' })
  }

  async saveSettings(
    actorId: string,
    next: { folderEnabled: boolean; schedule: BackupSchedule; keep: number },
  ): Promise<void> {
    const { settings } = this.d.repos
    if (next.schedule.enabled) {
      if (readPassphraseEnc(settings) === null)
        throw new BackupError('passphrase_not_set', 'Set a backup passphrase first.')
      if (!next.folderEnabled)
        throw new BackupError('destination_required', 'Scheduled backups need the backup folder.')
    }
    // Marked when the folder is turned on (or reconnected), while the admin says it is there.
    if (next.folderEnabled && !readFolderEnabled(settings)) {
      if (!(await this.folderAvailable()))
        throw new BackupError('folder_not_available', 'No backup folder is set up for this Pond.')
      try {
        await fs.writeFile(
          path.join(this.d.paths.folderDir!, MARKER_FILE),
          'Pond writes its backups here. Do not delete this file.\n',
        )
      } catch {
        throw new BackupError('folder_not_available', "Pond can't write to the backup folder.")
      }
    }
    const before = readSchedule(settings)
    const folderWasOn = readFolderEnabled(settings)
    this.d.repos.transaction(() => {
      if (next.folderEnabled && !folderWasOn) this.startCounting()
      settings.set('global', '', KEYS.folderEnabled, next.folderEnabled)
      settings.set('global', '', KEYS.schedule, next.schedule)
      settings.set('global', '', KEYS.keep, next.keep)
      if (next.schedule.enabled && JSON.stringify(before) !== JSON.stringify(next.schedule)) {
        const at = this.d.now().toISOString()
        // Starts counting now, so turning it on doesn't run a backup straight away.
        writeStatus(settings, {
          scheduleRanAt: at,
          ...(before.enabled ? {} : { since: { folder: at }, lastScheduled: {} }),
        })
      }
      this.audit(actorId, 'backup.settings_changed', {
        folder: next.folderEnabled,
        scheduled: next.schedule.enabled,
        frequency: next.schedule.frequency,
        keep: next.keep,
      })
    })
  }

  // ---------- Making backups ----------

  private fileName(at: Date): string {
    const stamp = at
      .toISOString()
      .replace(/\.\d+Z$/, 'Z')
      .replace(/[-:]/g, '')
      .replace('T', '-')
    return `pond-backup-${this.instanceId()}-${stamp}.pond`
  }

  private async make(target: string, at: Date): Promise<number> {
    const enc = readPassphraseEnc(this.d.repos.settings)
    if (enc === null) throw new BackupError('passphrase_not_set', 'Set a backup passphrase first.')
    const { bytes } = await createBackupFile({
      db: this.d.db,
      paths: this.d.paths,
      gate: this.d.gate,
      passphrase: this.d.crypto.decrypt(enc),
      workFactor: this.d.workFactor,
      instanceId: this.instanceId(),
      pondVersion: this.d.pondVersion,
      createdAt: at,
      target,
    })
    return bytes
  }

  /** One backup or restore step at a time. */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.d.lock.acquire()
    this.running = true
    try {
      return await fn()
    } finally {
      this.running = false
      release()
    }
  }

  /** Records and audits one destination's backup, whether it works or not. */
  private async record<T extends { bytes: number }>(
    actorId: string | null,
    destination: Destination,
    at: Date,
    fn: () => Promise<T>,
  ): Promise<T> {
    const trigger = actorId === null ? 'schedule' : 'manual'
    try {
      const done = await fn()
      writeStatus(this.d.repos.settings, { [`${destination}SuccessAt`]: at.toISOString() })
      this.audit(actorId, 'backup.created', { destination, trigger, bytes: done.bytes })
      return done
    } catch (e) {
      const known = e instanceof BackupError ? e : new BackupError('backup_failed')
      this.audit(actorId, 'backup.failed', { destination, trigger, reason: known.code })
      throw e
    }
  }

  private attempt<T extends { bytes: number }>(
    actorId: string | null,
    destination: Destination,
    fn: (at: Date) => Promise<T>,
  ): Promise<T> {
    return this.locked(() => {
      const at = this.d.now()
      return this.record(actorId, destination, at, () => fn(at))
    })
  }

  async backupToFolder(actorId: string | null): Promise<{ filename: string }> {
    const { filename } = await this.attempt(actorId, 'folder', (at) => this.writeToFolder(at))
    return { filename }
  }

  private async writeToFolder(at: Date) {
    if (!readFolderEnabled(this.d.repos.settings) || !(await this.folderAvailable()))
      throw new BackupError('folder_not_available', 'The backup folder is not available.')
    // Without this, a missing USB drive would quietly fill the SD card instead.
    if (!(await this.markerPresent()))
      throw new BackupError(
        'folder_marker_missing',
        "The backup folder's marker is missing. Is the drive or share connected?",
      )
    const filename = this.fileName(at)
    const file = path.join(this.d.paths.folderDir!, filename)
    const bytes = await this.make(file, at)
    await this.prune(filename)
    return { bytes, filename, file }
  }

  /** Matches only the names this install gives its backups. */
  private ownName(): string {
    return `pond-backup-${this.instanceId()}-\\d{8}-\\d{6}Z\\.pond`
  }

  /** This install's older copies beyond the number to keep, never the one just made. */
  private surplus(names: string[], justMade: string): string[] {
    const own = new RegExp(`^${this.ownName()}$`)
    return names
      .filter((n) => own.test(n) && n !== justMade)
      .sort()
      .reverse()
      .slice(readKeep(this.d.repos.settings) - 1)
  }

  /**
   * Deletes the oldest copies beyond the number to keep. Only this install's own file names, and
   * only after a newer backup has passed its check (the one just made is never removed).
   */
  private async prune(justMade: string): Promise<void> {
    const dir = this.d.paths.folderDir!
    try {
      const names = await fs.readdir(dir)
      const leftover = new RegExp(`^${this.ownName()}\\.[0-9a-f]{8}\\.partial$`)
      for (const n of [...this.surplus(names, justMade), ...names.filter((x) => leftover.test(x))])
        await fs.rm(path.join(dir, n), { force: true })
    } catch {
      // The backup itself is good; old copies are tidied next time.
    }
  }

  /** Makes a backup to be saved by the browser. Fetch it once with `takeDownload`. */
  async backupForDownload(actorId: string, sessionId: string): Promise<{ downloadId: string }> {
    const { downloadId } = await this.attempt(actorId, 'download', async (at) => {
      await this.expireDownloads(true)
      const dir = path.join(this.d.paths.tmpDir, 'downloads')
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const downloadId = randomBytes(24).toString('base64url')
      const filename = this.fileName(at)
      const file = path.join(dir, filename)
      const bytes = await this.make(file, at)
      this.downloads.set(downloadId, {
        sessionId,
        path: file,
        filename,
        expiresAt: at.getTime() + DOWNLOAD_LIFETIME_MS,
      })
      return { bytes, downloadId }
    })
    return { downloadId }
  }

  private async expireDownloads(all = false): Promise<void> {
    for (const [id, item] of this.downloads) {
      if (!all && item.expiresAt > this.d.now().getTime()) continue
      this.downloads.delete(id)
      await fs.rm(item.path, { force: true })
    }
  }

  /** Once only. The caller deletes the file after sending it. */
  async takeDownload(
    actorId: string,
    sessionId: string,
    downloadId: string,
  ): Promise<Download | null> {
    await this.expireDownloads()
    const item = this.downloads.get(downloadId)
    if (!item || item.sessionId !== sessionId) return null
    this.downloads.delete(downloadId)
    this.audit(actorId, 'backup.downloaded')
    return { path: item.path, filename: item.filename }
  }

  /** Called every few minutes. Runs a scheduled backup if one has come due, even after downtime. */
  async runDue(): Promise<boolean> {
    await this.expireDownloads()
    const { settings } = this.d.repos
    const schedule = readSchedule(settings)
    if (!schedule.enabled || this.running || this.d.lock.restorePending) return false
    const now = this.d.now()
    const lastRun = readStatus(settings).scheduleRanAt
    if (!lastRun) {
      writeStatus(settings, { scheduleRanAt: now.toISOString() })
      return false
    }
    const when: Schedule =
      schedule.frequency === 'daily'
        ? { daily: { at: schedule.time } }
        : { weekly: { day: schedule.weekday as Weekday, at: schedule.time } }
    if (!isDue(when, new Date(lastRun), now, this.d.timeZone)) return false
    writeStatus(settings, { scheduleRanAt: now.toISOString() }) // first, so a crash won't loop
    if (!readFolderEnabled(settings)) return false
    try {
      await this.locked(() => this.runScheduled(now))
    } catch (e) {
      // Another backup or restore step is running: try again at the next check.
      if (e instanceof BackupError && e.code === 'busy') {
        writeStatus(settings, { scheduleRanAt: lastRun })
        return false
      }
      throw e
    }
    return true
  }

  /** The scheduled backup to the folder. How it went is kept; a failure is also thrown, to be logged. */
  private async runScheduled(at: Date): Promise<void> {
    const note = (run: ScheduledRun) =>
      writeStatus(this.d.repos.settings, { lastScheduled: { folder: run } })
    try {
      await this.record(null, 'folder', at, () => this.writeToFolder(at))
      note({ at: at.toISOString(), ok: true })
    } catch (e) {
      const reason = e instanceof BackupError ? e.code : 'backup_failed'
      note({ at: at.toISOString(), ok: false, reason })
      throw e
    }
  }
}
