/** How rclone is run (rcloneArgs, rcloneEnv, remoteProblem) and what is kept (withRemote). */
import fs from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeRclone } from '../../testing/fakeRclone.js'
import { tempDir } from '../../testing/backupWorld.js'
import { rcloneArgs, rcloneEnv, remoteProblem, type RcloneCommand } from './rclone.js'
import { parseRemoteSetup, writeRemoteConfig, type RemoteSetup } from './setup.js'
import { withRemote } from './store.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

const SETUP = parseRemoteSetup('[x]\ntype = dropbox\ntoken = {"access_token":"first"}')

describe('rcloneArgs(run) and rcloneEnv(home)', () => {
  /**
   * Inputs:   each of the three commands, with a file and folder name holding spaces
   * Expected: only copyto, lsjson or deletefile; the remote is always "pond:"; everything the
   *           user chose comes after "--", so it can't be read as an option
   */
  it('build a fixed argument list', () => {
    const commands: RcloneCommand[] = [
      { name: 'upload', from: '/data/tmp/a.pond', folder: 'My folder', filename: 'a.pond' },
      { name: 'list', folder: 'My folder' },
      { name: 'delete', folder: 'My folder', filename: 'a.pond' },
    ]
    const args = commands.map((command) =>
      rcloneArgs({ command, configPath: '/tmp/c.conf', homeDir: '/tmp/home' }),
    )
    expect(args.map((a) => a[0])).toEqual(['copyto', 'lsjson', 'deletefile'])
    expect(args.map((a) => a.slice(a.indexOf('--') + 1))).toEqual([
      ['/data/tmp/a.pond', 'pond:My folder/a.pond'],
      ['pond:My folder'],
      ['pond:My folder/a.pond'],
    ])
    for (const a of args) {
      expect(a).toContain('--config=/tmp/c.conf')
      expect(a).toContain('--ask-password=false')
      expect(a.join(' ')).not.toMatch(/\b(sync|purge|serve|rcd)\b|--rc\b/)
    }
  })

  /**
   * Inputs:   the environment built for a run, while Pond's own holds rclone and cloud variables
   * Expected: only the empty home and temp folders; nothing is inherited
   */
  it('inherit nothing from the environment', () => {
    process.env.RCLONE_CONFIG_POND_TYPE = 'local'
    try {
      expect(rcloneEnv('/h')).toEqual({
        HOME: '/h',
        XDG_CONFIG_HOME: '/h',
        XDG_CACHE_HOME: '/h',
        TMPDIR: '/h',
      })
    } finally {
      delete process.env.RCLONE_CONFIG_POND_TYPE
    }
  })
})

describe('remoteProblem(result)', () => {
  /** Inputs: typical rclone error lines. Expected: the matching plain reason. */
  it.each([
    ['couldn\'t fetch token: oauth2: "invalid_grant"', 'remote_sign_in_failed'],
    ['api error SignatureDoesNotMatch: 403', 'remote_sign_in_failed'],
    ['dial tcp: lookup x: no such host', 'remote_unreachable'],
    ['googleapi: Error: storageQuotaExceeded', 'remote_full'],
    ['something odd', 'remote_failed'],
  ])('reads "%s"', (stderr, expected) => {
    expect(remoteProblem({ code: 1, stdout: '', stderr })).toBe(expected)
  })
})

describe('withRemote(options, use)', () => {
  const setUp = async () => {
    const tmpDir = await tempDir()
    made.push(tmpDir)
    const rclone = createFakeRclone()
    const saved: RemoteSetup[] = []
    const go = <T>(use: Parameters<typeof withRemote<T>>[1]) =>
      withRemote({ rclone, tmpDir, setup: SETUP, onChange: (s) => saved.push(s) }, use)
    return { tmpDir, rclone, saved, go }
  }
  const refreshed = (config: string) => config.replace('first', 'second')

  /**
   * Inputs:   a listing during which rclone rewrites the token, then a failing one that does too
   * Expected: the new token is handed back both times (a retired token must not be lost), once
   *           per change, and the private config is deleted
   */
  it('saves a new token after success and after failure', async () => {
    for (const fail of [false, true]) {
      const w = await setUp()
      w.rclone.rewrite = refreshed
      if (fail) w.rclone.fail.list = 'boom'
      const run = w.go(async (s) => {
        await s.list('f')
        return s.list('f')
      })
      if (fail) await expect(run).rejects.toMatchObject({ code: 'remote_failed' })
      else await run
      expect(w.saved.map(writeRemoteConfig)).toEqual([refreshed(writeRemoteConfig(SETUP))])
      expect(await fs.readdir(w.tmpDir)).toEqual([])
    }
  })

  /**
   * Inputs:   a run that leaves the config alone; one that adds a refused setting; one that
   *           changes the service
   * Expected: nothing is saved
   */
  it('saves nothing unchanged or unacceptable', async () => {
    for (const rewrite of [
      null,
      (c: string) => `${c}token_url = https://evil.example\n`,
      () => '[pond]\ntype = b2\naccount = a\nkey = b\n',
    ]) {
      const w = await setUp()
      w.rclone.rewrite = rewrite
      await w.go((s) => s.list('f'))
      expect(w.saved).toEqual([])
    }
  })

  /**
   * Inputs:   rclone's error text holding a token
   * Expected: the error carries a plain message only
   */
  it("never passes rclone's error text on", async () => {
    const w = await setUp()
    w.rclone.fail.list = 'GET https://x/?access_token=SECRET: 401'
    const error = await w.go((s) => s.list('f')).catch((e: Error) => e)
    expect(JSON.stringify([(error as Error).message, error])).not.toContain('SECRET')
  })
})
