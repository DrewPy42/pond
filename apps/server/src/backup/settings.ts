/** What backups remember, in the core settings table. */
import type { BackupSchedule, ScheduledDestination } from '@pond/shared'
import type { SettingsRepo } from '../repos/types.js'

export const KEYS = {
  instanceId: 'backup.instanceId',
  /** Encrypted with the master key, so scheduled backups can run unattended. */
  passphrase: 'backup.passphrase',
  schedule: 'backup.schedule',
  folderEnabled: 'backup.folderEnabled',
  keep: 'backup.keep',
  /** The rclone config, encrypted: it holds sign-in tokens. */
  remote: 'backup.remote',
  /** The remote's service, folder and switches. Nothing secret. */
  remoteInfo: 'backup.remoteInfo',
  status: 'backup.status',
} as const

export const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: false,
  frequency: 'daily',
  time: '02:00',
  weekday: 0,
}
export const DEFAULT_KEEP = 14

export interface ScheduledRun {
  at: string
  ok: boolean
  reason?: string
}

export interface BackupStatus {
  /** The newest checked backup written to the folder. */
  folderSuccessAt?: string
  /** The newest upload the remote confirmed. */
  remoteSuccessAt?: string
  downloadSuccessAt?: string
  /** The latest scheduled run for each destination, so one working can't hide another failing. */
  lastScheduled?: Partial<Record<ScheduledDestination, ScheduledRun>>
  /** When each destination began being backed up on a schedule. */
  since?: Partial<Record<ScheduledDestination, string>>
  /** The schedule counts from here: when it was turned on, or last ran. */
  scheduleRanAt?: string
}

export interface RemoteInfo {
  type: string
  folder: string
  enabled: boolean
  /** Set by a restore. Nothing is sent or deleted until an admin turns it back on. */
  paused: boolean
}

const get = <T>(repo: SettingsRepo, key: string, fallback: T): T =>
  (repo.get('global', '', key) as T | undefined) ?? fallback

/** Reads what M8a stored too, when the folder was the only scheduled destination. */
export function readStatus(repo: SettingsRepo): BackupStatus {
  const stored = get<BackupStatus & { scheduleSince?: string }>(repo, KEYS.status, {})
  const { scheduleSince, ...status } = stored
  const old = status.lastScheduled as unknown as ScheduledRun | undefined
  if (old && 'ok' in old) status.lastScheduled = { folder: old }
  if (scheduleSince && !status.since) status.since = { folder: scheduleSince }
  return status
}
export const writeStatus = (repo: SettingsRepo, patch: Partial<BackupStatus>): void =>
  repo.set('global', '', KEYS.status, { ...readStatus(repo), ...patch })
export const readSchedule = (repo: SettingsRepo): BackupSchedule =>
  get(repo, KEYS.schedule, DEFAULT_SCHEDULE)
export const readKeep = (repo: SettingsRepo): number => get(repo, KEYS.keep, DEFAULT_KEEP)
export const readFolderEnabled = (repo: SettingsRepo): boolean =>
  get(repo, KEYS.folderEnabled, false)
export const readRemoteInfo = (repo: SettingsRepo): RemoteInfo | null =>
  get<RemoteInfo | null>(repo, KEYS.remoteInfo, null)
export const readRemoteEnc = (repo: SettingsRepo): string | null =>
  get<string | null>(repo, KEYS.remote, null)
export const readPassphraseEnc = (repo: SettingsRepo): string | null =>
  get<string | null>(repo, KEYS.passphrase, null)

/**
 * The restored status describes the old install's past. Start over from now, so an old schedule
 * doesn't run (and tidy up old copies) the moment Pond starts. The remote is paused: a restored
 * copy has the same install id, so beside the original it would delete the original's backups,
 * and its sign-in token may be out of date.
 */
export function resetStatusAfterRestore(repo: SettingsRepo, now: Date): void {
  const at = now.toISOString()
  repo.set('global', '', KEYS.status, { scheduleRanAt: at, since: { folder: at, remote: at } })
  const remote = readRemoteInfo(repo)
  if (remote) repo.set('global', '', KEYS.remoteInfo, { ...remote, paused: true })
}
