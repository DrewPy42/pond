import path from 'node:path'

/** Every place backup and restore read or write. */
export interface BackupPaths {
  dataDir: string
  dbPath: string
  keyPath: string
  filesDir: string
  /** Automatic safety copies. Unencrypted, so they never leave the data folder. */
  safetyDir: string
  /** Scratch space, emptied at every start. */
  tmpDir: string
  /** Uploaded backups, the staged restore and the swap journal. */
  restoreDir: string
  /** The one folder backups may be written to, set up outside the app. Null if there is none. */
  folderDir: string | null
}

export function backupPaths(dataDir: string, folderDir: string | null = null): BackupPaths {
  return {
    dataDir,
    dbPath: path.join(dataDir, 'pond.db'),
    keyPath: path.join(dataDir, 'keys', 'master.key'),
    filesDir: path.join(dataDir, 'files'),
    safetyDir: path.join(dataDir, 'backups'),
    tmpDir: path.join(dataDir, 'tmp'),
    restoreDir: path.join(dataDir, 'restore'),
    folderDir: folderDir === null ? null : path.resolve(folderDir),
  }
}
