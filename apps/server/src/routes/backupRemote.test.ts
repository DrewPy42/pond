/**
 * Online storage through /api/backups, on the real app with fake repositories, a fake database
 * and pretend storage (testing/fakeRclone.ts). Backups are real encrypted files.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readArchive } from '../backup/archive.js'
import { resetStatusAfterRestore } from '../backup/settings.js'
import { BACKUP_PASSPHRASE, tempDir, writeTree } from '../testing/backupWorld.js'
import { PASSWORD, bootstrapAdmin, createUser, makeEnv } from '../testing/harness.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

const DAY = 86_400_000
const SETUP = '[mine]\ntype = dropbox\ntoken = {"access_token":"SECRET-TOKEN"}'

async function world() {
  const dataDir = await tempDir()
  const folder = await tempDir()
  made.push(dataDir, folder)
  const env = makeEnv({ dataDir, backupFolder: folder })
  await writeTree(dataDir, { 'keys/master.key': randomBytes(32) })
  const admin = await bootstrapAdmin(env)
  await admin.client.post('/api/auth/reauth', { password: PASSWORD })
  await admin.client.put('/api/backups/passphrase', { passphrase: BACKUP_PASSPHRASE })
  const save = (over: object = {}) =>
    admin.client.put('/api/backups/remote', {
      setup: SETUP,
      folder: 'Pond',
      enabled: true,
      ...over,
    })
  const settings = (over: { folderEnabled?: boolean; keep?: number; scheduled?: boolean } = {}) =>
    admin.client.put('/api/backups/settings', {
      folderEnabled: over.folderEnabled ?? false,
      keep: over.keep ?? 14,
      schedule: {
        enabled: over.scheduled ?? false,
        frequency: 'daily',
        time: '02:00',
        weekday: 0,
      },
    })
  const run = () => admin.client.post('/api/backups/run', { destination: 'remote' })
  const view = async () => (await admin.client.get('/api/backups')).body
  const remoteNames = () => [...env.rclone.files.keys()].sort()
  const audits = () => env.ctx.repos.audit.list({ limit: 200 })
  const stored = (key: string) => env.ctx.repos.settings.get('global', '', key)
  return { env, admin, folder, save, settings, run, view, remoteNames, audits, stored, dataDir }
}

describe('PUT and DELETE /api/backups/remote', () => {
  /**
   * Inputs:   no session, a non-admin, and an admin whose password re-check has expired
   * Expected: 401, 403 and 403 reauth_required; rclone is never run
   */
  it('need an admin who has just re-entered their password', async () => {
    const w = await world()
    const user = await createUser(w.env, w.admin, 'bob')
    for (const method of ['put', 'delete'] as const) {
      expect((await user.client.send(method, '/api/backups/remote', {})).status).toBe(403)
      w.env.advance(6 * 60_000)
      const stale = await w.admin.client.send(method, '/api/backups/remote', {})
      expect(stale.body.error).toBe('reauth_required')
    }
    expect(w.env.rclone.runs).toEqual([])
  })

  /**
   * Inputs:   a good setup
   * Expected: the folder is listed to check it; the config is stored encrypted; the response,
   *           the view and the audit log hold no token
   */
  it('checks the folder, stores the setup encrypted and never shows it', async () => {
    const w = await world()
    const res = await w.save()
    expect(res.body.remote).toEqual({
      available: true,
      configured: true,
      service: 'Dropbox',
      folder: 'Pond',
      enabled: true,
      paused: false,
    })
    expect(w.env.rclone.runs.map((r) => r.command)).toEqual([{ name: 'list', folder: 'Pond' }])
    const enc = w.stored('backup.remote') as string
    expect(w.env.ctx.crypto.decrypt(enc)).toContain('SECRET-TOKEN')
    expect(JSON.stringify([res.body, await w.view(), w.audits(), enc])).not.toContain(
      'SECRET-TOKEN',
    )
  })

  /**
   * Inputs:   a refused setting, a bad folder, a sign-in that fails, and no rclone
   * Expected: each answers with its reason and nothing is saved
   */
  it('saves nothing if the setup, folder or sign-in is bad', async () => {
    const w = await world()
    expect((await w.save({ setup: `${SETUP}\ntoken_url = https://x` })).body.error).toBe(
      'bad_remote_setup',
    )
    expect((await w.save({ folder: '../up' })).body.error).toBe('bad_remote_folder')
    expect(w.env.rclone.runs).toEqual([])
    w.env.rclone.fail.list = 'invalid_grant'
    expect((await w.save()).body.error).toBe('remote_sign_in_failed')
    w.env.rclone.installed = false
    expect((await w.save()).body.error).toBe('remote_not_available')
    expect(w.stored('backup.remote')).toBeUndefined()
    expect((await w.view()).remote).toMatchObject({ configured: false, available: false })
  })

  /**
   * Inputs:   a new folder without pasting again; turning it off; removing it while a
   *           remote-only schedule is on
   * Expected: the stored setup is kept; removing forgets it and turns the schedule off, leaving
   *           uploaded files alone
   */
  it('keeps, turns off and removes the stored setup', async () => {
    const w = await world()
    await w.save()
    await w.settings({ scheduled: true })
    await w.run()
    const moved = await w.admin.client.put('/api/backups/remote', {
      folder: 'Other',
      enabled: true,
    })
    expect(moved.body.remote.folder).toBe('Other')
    expect(w.env.ctx.crypto.decrypt(w.stored('backup.remote') as string)).toContain('SECRET')
    const gone = await w.admin.client.delete('/api/backups/remote')
    expect(gone.body.remote.configured).toBe(false)
    expect(gone.body.schedule.enabled).toBe(false)
    expect(w.stored('backup.remote')).toBeUndefined()
    expect(w.remoteNames()).toHaveLength(1)
  })

  /**
   * Inputs:   a token that rclone refreshes during an upload
   * Expected: the new token is what Pond keeps
   */
  it('keeps the token rclone refreshes', async () => {
    const w = await world()
    await w.save()
    w.env.rclone.rewrite = (c) => c.replace('SECRET-TOKEN', 'NEW-TOKEN')
    await w.run()
    expect(w.env.ctx.crypto.decrypt(w.stored('backup.remote') as string)).toContain('NEW-TOKEN')
  })
})

describe('backing up to online storage', () => {
  /**
   * Inputs:   "back up to online storage" with the folder off
   * Expected: one file is uploaded that opens with the passphrase, and nothing is left in the
   *           temporary folder
   */
  it('uploads a checked backup and cleans up', async () => {
    const w = await world()
    await w.save()
    const res = await w.run()
    expect(w.remoteNames()).toEqual([`Pond/${res.body.filename}`])
    const copy = path.join(w.folder, 'copy')
    await fs.writeFile(copy, w.env.rclone.files.get(w.remoteNames()[0]!)!)
    await readArchive({ source: copy, passphrase: BACKUP_PASSPHRASE })
    expect(await fs.readdir(w.env.paths.tmpDir)).toEqual([])
    expect((await w.view()).lastRemoteBackupAt).not.toBeNull()
  })

  /**
   * Inputs:   keep 2; four uploads; the folder also holds another install's backup and a note
   * Expected: this install's two newest and the other files remain
   */
  it('keeps the newest copies and deletes only its own files', async () => {
    const w = await world()
    await w.save()
    await w.settings({ keep: 2 })
    const others = ['Pond/notes.txt', 'Pond/pond-backup-ffffffffffff-20200101-000000Z.pond']
    for (const n of others) w.env.rclone.files.set(n, Buffer.from('mine'))
    const names: string[] = []
    for (let i = 0; i < 4; i++) {
      w.env.advance(1000)
      names.push(`Pond/${(await w.run()).body.filename}`)
    }
    expect(w.remoteNames()).toEqual([...others, ...names.slice(2)].sort())
  })

  /**
   * Inputs:   keep 1, one good upload, then one that arrives cut short and one that fails
   * Expected: unconfirmed and failed uploads delete nothing
   */
  it('deletes nothing unless the new upload is confirmed', async () => {
    const w = await world()
    await w.save()
    await w.settings({ keep: 1 })
    const good = `Pond/${(await w.run()).body.filename}`
    w.env.rclone.truncate = true
    w.env.advance(1000)
    expect((await w.run()).body.error).toBe('remote_upload_unconfirmed')
    w.env.rclone.truncate = false
    w.env.rclone.fail.upload = 'quota exceeded'
    w.env.advance(1000)
    expect((await w.run()).body.error).toBe('remote_full')
    expect(w.remoteNames()).toContain(good)
    expect(w.env.rclone.runs.filter((r) => r.command.name === 'delete')).toEqual([])
  })
})

describe('the schedule with online storage', () => {
  /**
   * Inputs:   a schedule with neither destination, then with online storage only
   * Expected: the first is refused; the second runs and uploads
   */
  it('needs somewhere to go, and online storage is enough', async () => {
    const w = await world()
    expect((await w.settings({ scheduled: true })).body.error).toBe('destination_required')
    await w.save()
    expect((await w.settings({ scheduled: true })).status).toBe(200)
    w.env.advance(DAY)
    expect(await w.env.ctx.backups.runDue()).toBe(true)
    expect(w.remoteNames()).toHaveLength(1)
  })

  /**
   * Inputs:   both destinations on and a scheduled run
   * Expected: the same file, byte for byte, in both places
   */
  it('sends one backup to the folder and the remote', async () => {
    const w = await world()
    await w.save()
    await w.settings({ folderEnabled: true, scheduled: true })
    w.env.advance(DAY)
    await w.env.ctx.backups.runDue()
    const [name] = (await fs.readdir(w.folder)).filter((n) => n.endsWith('.pond'))
    expect(w.remoteNames()).toEqual([`Pond/${name}`])
    expect(w.env.rclone.files.get(`Pond/${name}`)).toEqual(
      await fs.readFile(path.join(w.folder, name!)),
    )
    expect(w.env.ctx.backups.warnings()).toEqual([])
  })

  /**
   * Inputs:   both on; first the upload fails, then (next day) the folder's marker is missing
   * Expected: each time the other destination still gets its backup, and only the failing one
   *           is warned about
   */
  it("doesn't let one destination hide or stop the other", async () => {
    const w = await world()
    await w.save()
    await w.settings({ folderEnabled: true, scheduled: true })
    w.env.rclone.fail.upload = 'no such host'
    w.env.advance(DAY)
    await expect(w.env.ctx.backups.runDue()).rejects.toMatchObject({ code: 'remote_unreachable' })
    expect(w.env.ctx.backups.warnings()).toMatchObject([
      { destination: 'remote', kind: 'failed', reason: 'remote_unreachable' },
    ])
    delete w.env.rclone.fail.upload
    await fs.rm(path.join(w.folder, '.pond-backup-folder'))
    w.env.advance(DAY)
    await expect(w.env.ctx.backups.runDue()).rejects.toMatchObject({
      code: 'folder_marker_missing',
    })
    expect(w.remoteNames()).toHaveLength(1)
    expect(w.env.ctx.backups.warnings()).toMatchObject([{ destination: 'folder', kind: 'failed' }])
  })

  /**
   * Inputs:   the folder scheduled for 10 days with no runs, then online storage added
   * Expected: only the folder is stale: a new destination is judged from when it was added
   */
  it('counts staleness from when each destination was added', async () => {
    const w = await world()
    await w.settings({ folderEnabled: true, scheduled: true })
    w.env.advance(10 * DAY)
    await w.admin.client.post('/api/auth/reauth', { password: PASSWORD })
    await w.save()
    expect(w.env.ctx.backups.warnings()).toMatchObject([{ destination: 'folder', kind: 'stale' }])
  })

  /**
   * Inputs:   the status as M8a stored it (one scheduled result, folder only)
   * Expected: it still warns about the folder after the upgrade
   */
  it('reads the status an M8a install saved', async () => {
    const w = await world()
    await w.settings({ folderEnabled: true, scheduled: true })
    w.env.ctx.repos.settings.set('global', '', 'backup.status', {
      lastScheduled: { at: '2026-01-01T02:00:00.000Z', ok: false, reason: 'not_enough_space' },
      scheduleSince: '2026-01-01T00:00:00.000Z',
    })
    expect(w.env.ctx.backups.warnings()).toMatchObject([
      { destination: 'folder', kind: 'failed', reason: 'not_enough_space' },
    ])
  })
})

describe('after a restore (resetStatusAfterRestore)', () => {
  /**
   * Inputs:   keep 1, an existing upload, a daily remote schedule, then the restore reset
   * Expected: the remote is paused: the schedule and "back up now" upload and delete nothing,
   *           and admins are warned. Turning it back on checks the folder and resumes.
   */
  it('pauses online storage until an admin turns it back on', async () => {
    const w = await world()
    await w.save()
    await w.settings({ keep: 1, scheduled: true })
    await w.run()
    const before = w.remoteNames()
    const runs = w.env.rclone.runs.length
    resetStatusAfterRestore(w.env.ctx.repos.settings, w.env.ctx.now())

    // Past 02:00, visiting halfway so the admin's sign-in doesn't time out.
    w.env.advance(8 * 3_600_000)
    await w.view()
    w.env.advance(8 * 3_600_000)
    expect(await w.env.ctx.backups.runDue()).toBe(false)
    await w.admin.client.post('/api/auth/reauth', { password: PASSWORD })
    expect((await w.run()).body.error).toBe('remote_paused')
    expect(w.env.rclone.runs).toHaveLength(runs)
    expect(w.remoteNames()).toEqual(before)
    expect((await w.view()).warnings).toEqual([{ destination: 'remote', kind: 'paused' }])
    // Other settings can still be saved while it waits.
    expect((await w.settings({ keep: 3, scheduled: true })).status).toBe(200)

    const on = await w.admin.client.put('/api/backups/remote', { folder: 'Pond', enabled: true })
    expect(on.body.remote.paused).toBe(false)
    expect(on.body.warnings).toEqual([])
    expect((await w.run()).status).toBe(200)
  })
})
