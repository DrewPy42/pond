import { isFileRef, type FileRef, type FileStore } from '../files/store.js'

/** The in-memory FileStore for functionality tests. Held to the same contract as the disk one. */
export function createFakeFileStore(): FileStore & { keys(): string[] } {
  const files = new Map<string, Buffer>()
  const key = (r: FileRef) => `${r.padId}/${r.spaceId}/${r.fileId}`
  return {
    async put(ref, bytes) {
      if (!isFileRef(ref)) throw new Error('Invalid file reference')
      files.set(key(ref), Buffer.from(bytes))
    },
    async get(ref) {
      const found = isFileRef(ref) ? files.get(key(ref)) : undefined
      return found ? Buffer.from(found) : null
    },
    async remove(ref) {
      files.delete(key(ref))
    },
    async removePad(padId) {
      for (const k of [...files.keys()]) if (k.startsWith(`${padId}/`)) files.delete(k)
    },
    keys: () => [...files.keys()].sort(),
  }
}
