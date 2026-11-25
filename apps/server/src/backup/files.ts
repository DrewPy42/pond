import fs from 'node:fs/promises'
import path from 'node:path'
import { isFileEntry } from './manifest.js'

/**
 * The uploaded files under `filesDir`, as archive paths (`files/<pad>/<space>/<file>`), sorted.
 * Half-written temporary files, links and anything else the file store didn't make are left out.
 */
export async function listFileEntries(filesDir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let items
    try {
      items = await fs.readdir(dir, { withFileTypes: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    for (const item of items) {
      const name = `${prefix}/${item.name}`
      if (item.isDirectory()) await walk(path.join(dir, item.name), name)
      else if (item.isFile() && isFileEntry(name)) out.push(name)
    }
  }
  await walk(filesDir, 'files')
  return out.sort()
}

/** Where an archive's `files/...` entry lives under `filesDir`. */
export const filePathOf = (filesDir: string, entry: string): string =>
  path.join(filesDir, ...entry.split('/').slice(1))
