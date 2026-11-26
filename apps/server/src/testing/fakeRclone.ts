/** Pretend online storage: records every run and keeps "uploaded" files in memory. */
import fs from 'node:fs/promises'
import type { Rclone, RcloneCommand, RcloneResult, RcloneRun } from '../backup/remote/rclone.js'

export interface FakeRclone extends Rclone {
  installed: boolean
  /** What the remote holds, as "folder/name" to contents. */
  files: Map<string, Buffer>
  /** Every run, with the config file as rclone found it. */
  runs: (RcloneRun & { config: string })[]
  /** Fail runs of this command, with this error text. */
  fail: Partial<Record<RcloneCommand['name'], string>>
  /** If set, each run rewrites the config through this, as rclone does on a token refresh. */
  rewrite: ((config: string) => string) | null
  /** Uploads arrive cut short, though rclone reports success. */
  truncate: boolean
}

export function createFakeRclone(): FakeRclone {
  const ok = (stdout = ''): RcloneResult => ({ code: 0, stdout, stderr: '' })
  const fake: FakeRclone = {
    installed: true,
    files: new Map(),
    runs: [],
    fail: {},
    rewrite: null,
    truncate: false,
    available: () => fake.installed,
    async run(run) {
      const config = await fs.readFile(run.configPath, 'utf8')
      fake.runs.push({ ...run, config })
      if (fake.rewrite) await fs.writeFile(run.configPath, fake.rewrite(config))
      const { command } = run
      const stderr = fake.fail[command.name]
      if (stderr !== undefined) return { code: 1, stdout: '', stderr }
      if (command.name === 'upload') {
        const bytes = await fs.readFile(command.from)
        fake.files.set(
          `${command.folder}/${command.filename}`,
          fake.truncate ? bytes.subarray(0, 10) : bytes,
        )
        return ok()
      }
      if (command.name === 'delete') {
        return fake.files.delete(`${command.folder}/${command.filename}`)
          ? ok()
          : { code: 4, stdout: '', stderr: 'object not found' }
      }
      const prefix = `${command.folder}/`
      const found = [...fake.files]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map(([k, v]) => ({ Name: k.slice(prefix.length), Size: v.length }))
      return found.length
        ? ok(JSON.stringify(found))
        : { code: 3, stdout: '[\n', stderr: 'directory not found' }
    },
  }
  return fake
}
