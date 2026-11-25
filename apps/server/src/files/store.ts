import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Crypto } from '../crypto/index.js'

/** Where a file lives. Every part is checked: a pad can't name a path, only ids. */
export interface FileRef {
  padId: string
  spaceId: string
  fileId: string
}

/**
 * Storage for LilyPad files (docs/business-pad-design.md). Files are always reached through the
 * Space they were stored in. `get` returns null for anything that isn't there, including ids that
 * could not be a file at all.
 */
export interface FileStore {
  put(ref: FileRef, bytes: Buffer): Promise<void>
  get(ref: FileRef): Promise<Buffer | null>
  /** Removing a file that isn't there is not an error. */
  remove(ref: FileRef): Promise<void>
  removePad(padId: string): Promise<void>
}

const PAD_ID = /^[a-z][a-z0-9-]{1,29}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

export const isFileRef = (r: FileRef): boolean =>
  PAD_ID.test(r.padId) && ID.test(r.spaceId) && ID.test(r.fileId)

const assertRef = (r: FileRef): void => {
  if (!isFileRef(r)) throw new Error('Invalid file reference')
}

/**
 * Files on disk at `<root>/<padId>/<spaceId>/<fileId>`, each encrypted with the master key. The
 * three ids are authenticated with the contents, so a file copied or renamed elsewhere won't open.
 */
export function createDiskFileStore(root: string, crypto: Crypto): FileStore {
  const pathOf = (r: FileRef) => path.join(root, r.padId, r.spaceId, r.fileId)
  const context = (r: FileRef) => `pond-file:${r.padId}/${r.spaceId}/${r.fileId}`
  return {
    async put(ref, bytes) {
      assertRef(ref)
      const target = pathOf(ref)
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      // Written under a temporary name first, so a power cut can't leave half a file in place.
      const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`
      try {
        await fs.writeFile(temp, crypto.encryptBytes(bytes, context(ref)), {
          mode: 0o600,
          flag: 'wx',
          flush: true,
        })
        await fs.rename(temp, target)
      } finally {
        await fs.rm(temp, { force: true })
      }
    },
    async get(ref) {
      if (!isFileRef(ref)) return null
      let stored: Buffer
      try {
        stored = await fs.readFile(pathOf(ref))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
      return crypto.decryptBytes(stored, context(ref))
    },
    async remove(ref) {
      if (!isFileRef(ref)) return
      await fs.rm(pathOf(ref), { force: true })
    },
    async removePad(padId) {
      if (!PAD_ID.test(padId)) throw new Error('Invalid pad id')
      await fs.rm(path.join(root, padId), { recursive: true, force: true })
    },
  }
}
