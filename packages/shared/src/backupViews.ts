/** What the Backups screens show. No passphrase or key ever appears here. */
export interface BackupSchedule {
  enabled: boolean
  frequency: 'daily' | 'weekly'
  /** Local time, "HH:MM". */
  time: string
  /** For weekly: 0 (Sunday) to 6. */
  weekday: number
}

/** Places backups can be sent on a schedule. */
export type ScheduledDestination = 'folder' | 'remote'

export type BackupWarning = { destination: ScheduledDestination } & (
  | { kind: 'failed'; at: string; reason: string }
  | { kind: 'stale'; lastSuccessAt: string | null }
  /** After a restore, the remote waits for an admin. */
  | { kind: 'paused' }
)

/** The online storage backups go to. The pasted setup is never sent back. */
export interface BackupRemoteView {
  /** False when this Pond has no rclone. */
  available: boolean
  configured: boolean
  /** The service's plain name, such as "Dropbox". */
  service: string | null
  folder: string | null
  enabled: boolean
  paused: boolean
}

export interface BackupView {
  passphraseSet: boolean
  schedule: BackupSchedule
  keep: number
  folder: {
    /** The folder set up outside the app (in Docker), or null if there is none. */
    path: string | null
    available: boolean
    enabled: boolean
    /** False when enabled but the marker file is missing, such as an unplugged drive. */
    connected: boolean
  }
  remote: BackupRemoteView
  lastFolderBackupAt: string | null
  lastRemoteBackupAt: string | null
  lastDownloadAt: string | null
  running: boolean
  restorePending: boolean
  warnings: BackupWarning[]
}

export interface RestoreSummary {
  createdAt: string
  pondVersion: string
  counts: { users: number; spaces: number; accounts: number; transactions: number; files: number }
  warnings: string[]
}
