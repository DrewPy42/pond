/**
 * Checks on a database and its key. Restore runs them on what was uploaded; making a backup runs
 * the same ones, so Pond never reports success for a backup it would later refuse.
 */
import fs from 'node:fs/promises'
import { createCrypto } from '../crypto/index.js'
import { fileContext } from '../files/store.js'
import { BackupError } from './errors.js'
import { filePathOf } from './files.js'
import type { BackupDb } from './types.js'

export function checkDatabase(db: BackupDb, dbFile: string, key: Buffer): void {
  if (db.integrityProblems(dbFile).length > 0)
    throw new BackupError('damaged_backup', 'The database did not pass its integrity check.')
  const crypto = createCrypto(key)
  for (const value of db.encryptedValues(dbFile)) {
    try {
      crypto.decrypt(value)
    } catch {
      throw new BackupError('key_mismatch', "The master key doesn't open this database's secrets.")
    }
  }
}

/** How many uploaded files the key can't open. */
export async function countUnreadableFiles(
  entries: string[],
  filesDir: string,
  key: Buffer,
): Promise<number> {
  const crypto = createCrypto(key)
  let unreadable = 0
  for (const entry of entries) {
    const [, padId, spaceId, fileId] = entry.split('/') as [string, string, string, string]
    try {
      crypto.decryptBytes(
        await fs.readFile(filePathOf(filesDir, entry)),
        fileContext({ padId, spaceId, fileId }),
      )
    } catch {
      unreadable++
    }
  }
  return unreadable
}
