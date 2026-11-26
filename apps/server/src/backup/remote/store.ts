/**
 * The remote Pond uploads to. Each run gets a private copy of the config, and afterwards any new
 * token rclone wrote is saved back, encrypted: some services issue a new one every time and
 * retire the old.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { BackupError } from '../errors.js'
import { remoteProblem, type Rclone, type RcloneCommand, type RcloneResult } from './rclone.js'
import { parseRemoteSetup, writeRemoteConfig, type RemoteSetup } from './setup.js'

export interface RemoteSession {
  /** Throws unless the folder can be listed or simply doesn't exist yet. */
  list(folder: string): Promise<{ name: string; size: number }[]>
  upload(from: string, folder: string, filename: string): Promise<void>
  delete(folder: string, filename: string): Promise<void>
}

/** rclone's "directory not found": the first upload creates the folder. */
const NO_SUCH_FOLDER = 3

const listing = z.array(z.object({ Name: z.string(), Size: z.number() }))

const PROBLEMS = {
  remote_sign_in_failed:
    'The storage service refused the sign-in. Make a new setup with rclone and paste it again.',
  remote_unreachable: "Pond couldn't reach the storage service. Check the internet connection.",
  remote_full: 'The storage service says there is no room left.',
  remote_failed: 'The storage service reported a problem.',
} as const

const failure = (result: RcloneResult) => {
  const code = remoteProblem(result)
  return new BackupError(code, PROBLEMS[code])
}

/**
 * Runs `use` against a config made from `setup`. `onChange` receives the new setup if rclone
 * changed it, and is called even when `use` fails.
 */
export async function withRemote<T>(
  o: {
    rclone: Rclone
    tmpDir: string
    setup: RemoteSetup
    onChange: (setup: RemoteSetup) => void
  },
  use: (session: RemoteSession) => Promise<T>,
): Promise<T> {
  if (!o.rclone.available())
    throw new BackupError('remote_not_available', "This Pond doesn't have rclone installed.")
  await fs.mkdir(o.tmpDir, { recursive: true, mode: 0o700 })
  const dir = await fs.mkdtemp(path.join(o.tmpDir, 'rclone-'))
  const configPath = path.join(dir, 'rclone.conf')
  const homeDir = path.join(dir, 'home')
  const written = writeRemoteConfig(o.setup)
  let current = written

  /** After every run, so a crash between runs loses as little as possible. */
  const keepChanges = async () => {
    let next: RemoteSetup
    try {
      const text = await fs.readFile(configPath, 'utf8')
      next = parseRemoteSetup(text)
    } catch {
      return // not something Pond would accept: keep what it had
    }
    const normalized = writeRemoteConfig(next)
    if (next.type !== o.setup.type || normalized === current) return
    current = normalized
    o.onChange(next)
  }
  const run = async (command: RcloneCommand): Promise<RcloneResult> => {
    try {
      return await o.rclone.run({ command, configPath, homeDir })
    } finally {
      await keepChanges()
    }
  }

  try {
    await fs.mkdir(homeDir, { mode: 0o700 })
    await fs.writeFile(configPath, written, { mode: 0o600, flag: 'wx' })
    return await use({
      async list(folder) {
        const result = await run({ name: 'list', folder })
        if (result.code === NO_SUCH_FOLDER) return []
        if (result.code !== 0) throw failure(result)
        try {
          return listing
            .parse(JSON.parse(result.stdout))
            .map((f) => ({ name: f.Name, size: f.Size }))
        } catch {
          throw new BackupError('remote_failed', PROBLEMS.remote_failed)
        }
      },
      async upload(from, folder, filename) {
        const result = await run({ name: 'upload', from, folder, filename })
        if (result.code !== 0) throw failure(result)
      },
      async delete(folder, filename) {
        const result = await run({ name: 'delete', folder, filename })
        if (result.code !== 0) throw failure(result)
      },
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
