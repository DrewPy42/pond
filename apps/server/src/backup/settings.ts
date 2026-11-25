/** What backups remember, in the core settings table. */
import type { BackupSchedule } from '@pond/shared'
import type { SettingsRepo } from '../repos/types.js'

export const KEYS = {
  instanceId: 'backup.instanceId',
  /** Encrypted with the master key, so scheduled backups can run unattended. */
  passphrase: 'backup.passphrase',
  schedule: 'backup.schedule',
  folderEnabled: 'backup.folderEnabled',
  keep: 'backup.keep',
  status: 'backup.status',
} as const

export const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: false,
  frequency: 'daily',
  time: '02:00',
  weekday: 0,
}
export const DEFAULT_KEEP = 14

export interface BackupStatus {
  /** The newest checked backup written to the folder. */
  folderSuccessAt?: string
  downloadSuccessAt?: string
  /** The latest scheduled run. */
  lastScheduled?: { at: string; ok: boolean; reason?: string }
  /** The schedule counts from here: when it was turned on, or last ran. */
  scheduleRanAt?: string
  scheduleSince?: string
}

const get = <T>(repo: SettingsRepo, key: string, fallback: T): T =>
  (repo.get('global', '', key) as T | undefined) ?? fallback

export const readStatus = (repo: SettingsRepo): BackupStatus => get(repo, KEYS.status, {})
export const writeStatus = (repo: SettingsRepo, patch: Partial<BackupStatus>): void =>
  repo.set('global', '', KEYS.status, { ...readStatus(repo), ...patch })
export const readSchedule = (repo: SettingsRepo): BackupSchedule =>
  get(repo, KEYS.schedule, DEFAULT_SCHEDULE)
export const readKeep = (repo: SettingsRepo): number => get(repo, KEYS.keep, DEFAULT_KEEP)
export const readFolderEnabled = (repo: SettingsRepo): boolean =>
  get(repo, KEYS.folderEnabled, false)
export const readPassphraseEnc = (repo: SettingsRepo): string | null =>
  get<string | null>(repo, KEYS.passphrase, null)

/**
 * The restored status describes the old install's past. Start over from now, so an old schedule
 * doesn't run (and tidy up old copies) the moment Pond starts.
 */
export function resetStatusAfterRestore(repo: SettingsRepo, now: Date): void {
  const at = now.toISOString()
  repo.set('global', '', KEYS.status, { scheduleRanAt: at, scheduleSince: at })
}
