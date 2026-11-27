/** What the Backups screens show. No passphrase or key ever appears here. */
export interface BackupSchedule {
  enabled: boolean
  frequency: 'daily' | 'weekly'
  /** Local time, "HH:MM". */
  time: string
  /** For weekly: 0 (Sunday) to 6. */
  weekday: number
}

/** What an admin should know about scheduled backups. */
export type BackupWarning =
  | { kind: 'failed'; at: string; reason: string }
  | { kind: 'stale'; lastSuccessAt: string | null }
  /** The schedule is on, but there is nowhere to save. */
  | { kind: 'no_destination' }

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
  lastFolderBackupAt: string | null
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
