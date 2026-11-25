/** Temporary folders and hand-made backup files for the backup and restore tests. */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sha256File, writeArchive } from '../backup/archive.js'
import { DB_PATH, FORMAT_VERSION, KEY_PATH, type Manifest } from '../backup/manifest.js'
import { fakeDbContent, type FakeDbContent } from './fakeBackupDb.js'

export const BACKUP_PASSPHRASE = 'seven wet frogs sat quietly'

export const tempDir = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'pond-test-'))

export async function writeTree(root: string, files: Record<string, string | Buffer>) {
  for (const [name, content] of Object.entries(files)) {
    const to = path.join(root, name)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.writeFile(to, content)
  }
}

/** Every file under `root` with its contents, to compare whole folders. */
export async function readTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const items = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const item of items) {
    if (!item.isFile()) continue
    const full = path.join(item.parentPath, item.name)
    out[path.relative(root, full)] = (await fs.readFile(full)).toString('base64')
  }
  return out
}

/**
 * A valid backup built by hand, so a test can make one that Pond itself would never write
 * (another key, a newer version). `files` maps archive paths to their bytes.
 */
export async function makeBackup(
  o: {
    db?: Partial<FakeDbContent>
    key?: Buffer
    files?: Record<string, Buffer>
    manifest?: Partial<Manifest>
    passphrase?: string
  } = {},
): Promise<Buffer> {
  const dir = await tempDir()
  const contents: Record<string, Buffer> = {
    [DB_PATH]: Buffer.from(JSON.stringify(fakeDbContent(o.db))),
    [KEY_PATH]: o.key ?? randomBytes(32),
    ...o.files,
  }
  const at = (p: string) => path.join(dir, 'source', p)
  await writeTree(path.join(dir, 'source'), contents)
  const entries = []
  for (const p of Object.keys(contents)) entries.push({ path: p, ...(await sha256File(at(p))) })
  const target = path.join(dir, 'made.pond')
  await writeArchive({
    target,
    passphrase: o.passphrase ?? BACKUP_PASSPHRASE,
    workFactor: 10,
    manifest: {
      app: 'pond',
      format: FORMAT_VERSION,
      pondVersion: '0.0.0',
      schemaVersion: 6,
      lilypads: {},
      instanceId: 'abc',
      createdAt: '2026-01-01T00:00:00.000Z',
      counts: {},
      entries,
      ...o.manifest,
    },
    sourceOf: (e) => at(e.path),
  })
  const bytes = await fs.readFile(target)
  await fs.rm(dir, { recursive: true, force: true })
  return bytes
}
