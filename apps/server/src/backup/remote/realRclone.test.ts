/**
 * Against a real rclone, found through POND_RCLONE_PATH; skipped without it. Only local folders
 * are used (a service Pond's own parser refuses, so only test code can set it up). Nothing signs
 * in to any cloud service.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from '../../testing/backupWorld.js'
import { createRclone, rcloneEnv } from './rclone.js'
import { parseRemoteSetup, writeRemoteConfig, type RemoteSetup, type RemoteType } from './setup.js'
import { withRemote } from './store.js'

const binary = process.env.POND_RCLONE_PATH ?? ''
const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true })
})
const scratch = async () => {
  const dir = await tempDir()
  made.push(dir)
  return dir
}

describe.skipIf(!binary)('with the real rclone', () => {
  const localRemote: RemoteSetup = { type: 'local' as RemoteType, settings: [] }

  /**
   * Function: createRclone and withRemote (upload, list, delete)
   * Inputs:   a folder that doesn't exist yet, with spaces in its name, and a small file
   * Expected: it lists as empty, the upload creates it and lists at the right size, delete
   *           removes it, and deleting it again fails
   */
  it('lists, uploads and deletes', async () => {
    const dir = await scratch()
    const source = path.join(dir, 'a.pond')
    await fs.writeFile(source, 'twelve bytes')
    const folder = path.join(dir, 'remote', 'Pond backups').slice(1)
    // The local type reads paths from the root, so the test spells the whole path.
    const rclone = createRclone(binary)
    const rooted = {
      ...rclone,
      run: (r: Parameters<typeof rclone.run>[0]) =>
        rclone.run({ ...r, command: { ...r.command, folder: `/${r.command.folder}` } }),
    }
    await withRemote(
      { rclone: rooted, tmpDir: dir, setup: localRemote, onChange: () => {} },
      async (s) => {
        expect(await s.list(folder)).toEqual([])
        await s.upload(source, folder, 'a.pond')
        expect(await s.list(folder)).toEqual([{ name: 'a.pond', size: 12 }])
        await s.delete(folder, 'a.pond')
        expect(await s.list(folder)).toEqual([])
        await expect(s.delete(folder, 'a.pond')).rejects.toMatchObject({ code: 'remote_failed' })
      },
    )
  }, 60_000)

  const dump = async (config: string) => {
    const dir = await scratch()
    const file = path.join(dir, 'c.conf')
    await fs.writeFile(file, config)
    const run = (...args: string[]) =>
      execFileSync(binary, [`--config=${file}`, '--ask-password=false', ...args], {
        env: rcloneEnv(dir),
        encoding: 'utf8',
      })
    return { run, read: () => fs.readFile(file, 'utf8') }
  }
  const TRICKY = 'a#b;c=d"e\'f\\g$h{i}%j(k)`l\\'

  /**
   * Function: writeRemoteConfig
   * Inputs:   secrets full of characters config readers treat specially, ending in a backslash
   * Expected: rclone reads back exactly what Pond checked
   */
  it('reads the config the way Pond wrote it', async () => {
    const setup = parseRemoteSetup(
      `[x]\ntype = s3\nprovider = Minio\naccess_key_id = ${TRICKY}\nsecret_access_key = "${TRICKY}"\nendpoint = https://nas.lan:9000\nno_check_bucket = true`,
    )
    const { run } = await dump(writeRemoteConfig(setup))
    expect(JSON.parse(run('config', 'dump')).pond).toEqual({
      type: 's3',
      ...Object.fromEntries(setup.settings),
    })
  })

  /**
   * Function: parseRemoteSetup on a config rclone itself has rewritten (token write-back)
   * Inputs:   Pond's config after "rclone config update" changes one value
   * Expected: Pond accepts rclone's rewritten file and sees the new value
   */
  it("accepts rclone's own rewritten config", async () => {
    const { run, read } = await dump(
      writeRemoteConfig(parseRemoteSetup('[x]\ntype = b2\naccount = abc\nkey = old')),
    )
    run('config', 'update', 'pond', 'key=newkey', '--non-interactive', '--no-obscure')
    expect(new Map(parseRemoteSetup(await read()).settings).get('key')).toBe('newkey')
  })
})
