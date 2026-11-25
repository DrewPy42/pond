import type { FileStore } from '../files/store.js'

export interface GatedFileStore extends FileStore {
  /** Holds back deletions until the returned function is called. */
  hold(): () => void
}

/**
 * While a backup or safety copy runs, no file may disappear: its database snapshot would point at
 * a file that's gone. Single deletions are put off until afterwards (if Pond stops first, an
 * unused file is left behind, which is harmless). Removing a whole pad's files waits instead.
 */
export function createGatedFileStore(inner: FileStore): GatedFileStore {
  let holders = 0
  const deferred: Parameters<FileStore['remove']>[0][] = []
  let waiting: (() => void)[] = []
  const idle = () => new Promise<void>((resolve) => waiting.push(resolve))

  return {
    put: (ref, bytes) => inner.put(ref, bytes),
    get: (ref) => inner.get(ref),
    async remove(ref) {
      if (holders > 0) deferred.push(ref)
      else await inner.remove(ref)
    },
    async removePad(padId) {
      while (holders > 0) await idle()
      await inner.removePad(padId)
    },
    hold() {
      holders++
      let released = false
      return () => {
        if (released) return
        released = true
        if (--holders > 0) return
        for (const ref of deferred.splice(0)) void inner.remove(ref).catch(() => {})
        const wake = waiting
        waiting = []
        for (const w of wake) w()
      }
    },
  }
}
