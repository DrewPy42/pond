/**
 * /api/backups and /api/setup/restore, driven through the real app with fake repositories and a
 * fake database. Backups are real encrypted files in temporary folders.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { readArchive } from '../backup/archive.js'
import { journalPath } from '../backup/swap.js'
import { createCrypto } from '../crypto/index.js'
import { fakeDbContent, type FakeDbContent } from '../testing/fakeBackupDb.js'
import { BACKUP_PASSPHRASE, makeBackup, tempDir, writeTree } from '../testing/backupWorld.js'
import { Client, PASSWORD, bootstrapAdmin, createUser, makeEnv } from '../testing/harness.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

const DAY = 86_400_000
const FILE = 'files/business/s1/f1'
const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  )

/** A signed-in admin on an install with a real (temporary) data folder and backup folder. */
async function world(o: { folder?: boolean; passphrase?: boolean } = {}) {
  const dataDir = await tempDir()
  const folder = await tempDir()
  made.push(dataDir, folder)
  const env = makeEnv({ dataDir, backupFolder: o.folder === false ? undefined : folder })
  const key = randomBytes(32)
  await writeTree(dataDir, {
    'keys/master.key': key,
    [FILE]: createCrypto(key).encryptBytes(Buffer.from('receipt'), 'pond-file:business/s1/f1'),
  })
  const admin = await bootstrapAdmin(env)
  const reauth = () => admin.client.post('/api/auth/reauth', { password: PASSWORD })
  await reauth()
  if (o.passphrase !== false)
    await admin.client.put('/api/backups/passphrase', { passphrase: BACKUP_PASSPHRASE })
  const settings = (over: object = {}, schedule: object = {}) =>
    admin.client.put('/api/backups/settings', {
      folderEnabled: true,
      keep: 14,
      schedule: { enabled: false, frequency: 'daily', time: '02:00', weekday: 0, ...schedule },
      ...over,
    })
  const backups = async () => (await fs.readdir(folder)).filter((n) => n.endsWith('.pond')).sort()
  const audits = () => env.ctx.repos.audit.list({ limit: 200 })
  return { env, admin, reauth, settings, folder, backups, audits, key }
}

/** Sends a file as the raw request body, with this client's cookies. */
async function upload(
  env: ReturnType<typeof makeEnv>,
  client: Client,
  url: string,
  bytes: Buffer,
  headers: Record<string, string> = {},
) {
  const cookie = [...client.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
  let r = request(env.app).post(url).set('Content-Type', 'application/octet-stream').set(headers)
  if (cookie) r = r.set('Cookie', cookie).set('x-csrf-token', client.jar.get('pond_csrf') ?? '')
  return r.send(bytes)
}

const ROUTES = [
  ['get', '/api/backups'],
  ['put', '/api/backups/passphrase'],
  ['put', '/api/backups/settings'],
  ['post', '/api/backups/run'],
  ['get', '/api/backups/download/abc'],
  ['post', '/api/backups/restore/upload'],
  ['post', '/api/backups/restore/check'],
  ['post', '/api/backups/restore/confirm'],
] as const

describe('who may use /api/backups', () => {
  /**
   * Inputs:   every backup route with no session, and as a signed-in person who isn't an admin
   * Expected: 401 and 403; a backup holds everyone's data
   */
  it('is for signed-in admins only', async () => {
    const w = await world()
    const user = await createUser(w.env, w.admin, 'bob')
    await user.client.post('/api/auth/reauth', { password: PASSWORD })
    for (const [method, url] of ROUTES) {
      expect((await new Client(w.env.app).send(method, url, {})).status, url).toBe(401)
      expect((await user.client.send(method, url, {})).status, url).toBe(403)
    }
  })

  /**
   * Inputs:   an admin whose password re-check is more than 5 minutes old, on every route that
   *           changes settings, makes a backup or restores
   * Expected: 403 reauth_required
   */
  it('asks for the password again before anything sensitive', async () => {
    const w = await world()
    w.env.advance(6 * 60_000)
    for (const [method, url] of ROUTES.filter(([m]) => m !== 'get')) {
      const res = await w.admin.client.send(method, url, {})
      expect(res.body.error, url).toBe('reauth_required')
    }
    expect((await w.admin.client.get('/api/backups')).status).toBe(200)
  })
})

describe('PUT /api/backups/passphrase', () => {
  /**
   * Inputs:   an 11-character passphrase, then a good one
   * Expected: the short one is refused; the good one is stored encrypted and appears in neither
   *           the response nor the audit log
   */
  it('needs 12 characters, stores it encrypted and never shows or records it', async () => {
    const w = await world({ passphrase: false })
    const short = await w.admin.client.put('/api/backups/passphrase', { passphrase: 'elevenchars' })
    expect(short.body.error).toBe('weak_passphrase')
    const res = await w.admin.client.put('/api/backups/passphrase', {
      passphrase: BACKUP_PASSPHRASE,
    })
    expect(res.body.passphraseSet).toBe(true)
    const stored = w.env.ctx.repos.settings.get('global', '', 'backup.passphrase') as string
    expect(w.env.ctx.crypto.decrypt(stored)).toBe(BACKUP_PASSPHRASE)
    expect(JSON.stringify([res.body, stored, w.audits()])).not.toContain(BACKUP_PASSPHRASE)
  })
})

describe('POST /api/backups/run (download) and GET /api/backups/download/:id', () => {
  /**
   * Inputs:   "back up now" before a passphrase exists
   * Expected: 409 passphrase_not_set, and the failure is audited
   */
  it('refuses without a passphrase', async () => {
    const w = await world({ passphrase: false })
    const res = await w.admin.client.post('/api/backups/run', { destination: 'download' })
    expect(res.body.error).toBe('passphrase_not_set')
    expect(w.audits().some((a) => a.action === 'backup.failed')).toBe(true)
  })

  /**
   * Inputs:   a backup made by the admin; fetched by a second admin session, then by the
   *           maker twice
   * Expected: the other session gets 404; the maker gets a file that opens with the passphrase
   *           and holds the database, key and uploaded file, exactly once
   */
  it('hands the finished backup to the session that made it, once', async () => {
    const w = await world()
    const run = await w.admin.client.post('/api/backups/run', { destination: 'download' })
    const url = `/api/backups/download/${run.body.downloadId}`

    const second = await createUser(w.env, w.admin, 'eve')
    w.env.ctx.repos.users.update(second.id, {
      isAdmin: true,
      totpEnabledAt: '2026-01-01T00:00:00.000Z',
    })
    expect((await second.client.get(url)).status).toBe(404)

    const cookie = [...w.admin.client.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await request(w.env.app)
      .get(url)
      .set('Cookie', cookie)
      .buffer(true)
      .parse((r, done) => {
        const parts: Buffer[] = []
        r.on('data', (c: Buffer) => parts.push(c))
        r.on('end', () => done(null, Buffer.concat(parts)))
      })
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="pond-backup-[0-9a-f]{12}-20260101-\d{6}Z\.pond"/,
    )
    const saved = path.join(w.folder, 'saved')
    await fs.writeFile(saved, res.body as Buffer)
    const manifest = await readArchive({ source: saved, passphrase: BACKUP_PASSPHRASE })
    expect(manifest.entries.map((e) => e.path)).toEqual(['pond.db', 'keys/master.key', FILE])

    expect((await w.admin.client.get(url)).status).toBe(404)
    expect(await fs.readdir(path.join(w.env.paths.tmpDir, 'downloads'))).toEqual([])
    expect(w.audits().map((a) => a.action)).toEqual(
      expect.arrayContaining(['backup.created', 'backup.downloaded']),
    )
  })

  /**
   * Inputs:   a database whose stored secret was encrypted with a different key
   * Expected: the backup fails (restore would refuse it) and no file is left behind
   */
  it('does not report success for a backup that could not be restored', async () => {
    const w = await world()
    await w.settings()
    const db = w.env.ctx.backups['d'].db as unknown as { live: FakeDbContent }
    db.live = fakeDbContent({ secrets: [createCrypto(randomBytes(32)).encrypt('x')] })
    const res = await w.admin.client.post('/api/backups/run', { destination: 'folder' })
    expect(res.body.error).toBe('key_mismatch')
    expect(await fs.readdir(w.folder)).toEqual(['.pond-backup-folder'])
  })
})

describe('the backup folder', () => {
  /**
   * Inputs:   turning the folder on, then deleting the marker (an unplugged drive) and backing up
   * Expected: the marker is written when turned on; without it the backup fails loudly and writes
   *           nothing, instead of filling the SD card
   */
  it('refuses to write when its marker is missing', async () => {
    const w = await world()
    const on = await w.settings()
    expect(on.body.folder).toMatchObject({ enabled: true, connected: true })
    await fs.rm(path.join(w.folder, '.pond-backup-folder'))
    const res = await w.admin.client.post('/api/backups/run', { destination: 'folder' })
    expect(res.body.error).toBe('folder_marker_missing')
    expect(await fs.readdir(w.folder)).toEqual([])
    expect((await w.admin.client.get('/api/backups')).body.folder.connected).toBe(false)
  })

  /**
   * Inputs:   an install with no backup folder set up
   * Expected: the folder can't be turned on (there is no path to type)
   */
  it('cannot be turned on unless one was set up outside the app', async () => {
    const w = await world({ folder: false })
    expect((await w.settings()).body.error).toBe('folder_not_available')
  })

  /**
   * Inputs:   keep 2, three backups; the folder also holds another install's backup, a renamed
   *           copy and a note
   * Expected: this install's two newest remain; nothing else is touched
   */
  it('keeps the newest copies and deletes only its own files', async () => {
    const w = await world()
    await w.settings({ keep: 2 })
    const others = [
      'pond-backup-ffffffffffff-20200101-000000Z.pond',
      'my pond-backup copy.pond',
      'notes.txt',
    ]
    for (const n of others) await fs.writeFile(path.join(w.folder, n), 'mine')
    const names: string[] = []
    for (let i = 0; i < 3; i++) {
      w.env.advance(1000)
      names.push(
        (await w.admin.client.post('/api/backups/run', { destination: 'folder' })).body.filename,
      )
    }
    expect((await fs.readdir(w.folder)).sort()).toEqual(
      ['.pond-backup-folder', ...others, names[1]!, names[2]!].sort(),
    )
  })

  /**
   * Inputs:   keep 1 and a second backup that fails
   * Expected: the earlier good copy is still there
   */
  it('deletes nothing when the new backup fails', async () => {
    const w = await world()
    await w.settings({ keep: 1 })
    await w.admin.client.post('/api/backups/run', { destination: 'folder' })
    const before = await w.backups()
    ;(w.env.ctx.backups['d'].db as unknown as { failSnapshot: boolean }).failSnapshot = true
    w.env.advance(1000)
    const res = await w.admin.client.post('/api/backups/run', { destination: 'folder' })
    expect(res.body.error).toBe('not_enough_space')
    expect(await w.backups()).toEqual(before)
  })
})

describe('BackupService.runDue() and warnings', () => {
  /**
   * Inputs:   a daily 02:00 schedule turned on at 12:00 UTC; checks at once, at 01:59 and at 02:01
   * Expected: nothing runs until 02:00 passes, then exactly one backup
   */
  it('runs once when the time comes, not when first turned on', async () => {
    const w = await world()
    await w.settings({}, { enabled: true })
    expect(await w.env.ctx.backups.runDue()).toBe(false)
    w.env.advance(13 * 3_600_000 + 59 * 60_000)
    expect(await w.env.ctx.backups.runDue()).toBe(false)
    w.env.advance(2 * 60_000)
    expect(await w.env.ctx.backups.runDue()).toBe(true)
    expect(await w.env.ctx.backups.runDue()).toBe(false)
    expect(await w.backups()).toHaveLength(1)
    expect(w.env.ctx.backups.warning()).toBeNull()
  })

  /**
   * Inputs:   a scheduled run with the marker gone, then a good manual folder backup
   * Expected: a "failed" warning naming the reason, cleared by the good backup
   */
  it('warns when a scheduled backup fails, until a good one is made', async () => {
    const w = await world()
    await w.settings({}, { enabled: true })
    const marker = path.join(w.folder, '.pond-backup-folder')
    await fs.rm(marker)
    w.env.advance(DAY)
    await expect(w.env.ctx.backups.runDue()).rejects.toMatchObject({
      code: 'folder_marker_missing',
    })
    expect(w.env.ctx.backups.warning()).toMatchObject({
      kind: 'failed',
      reason: 'folder_marker_missing',
    })
    await fs.writeFile(marker, '')
    w.env.advance(1000)
    await w.env.ctx.backups.backupToFolder(null)
    expect(w.env.ctx.backups.warning()).toBeNull()
  })

  /**
   * Inputs:   schedules that never run (Pond's checks are not called) for 2, 4 and 11 days
   * Expected: daily warns after 3 days, weekly only after 10; no schedule never warns
   */
  it('warns when the newest good backup is too old for the schedule', async () => {
    const w = await world()
    await w.settings({}, { enabled: true })
    w.env.advance(2 * DAY)
    expect(w.env.ctx.backups.warning()).toBeNull()
    w.env.advance(2 * DAY)
    expect(w.env.ctx.backups.warning()).toEqual({ kind: 'stale', lastSuccessAt: null })

    const weekly = await world()
    await weekly.settings({}, { enabled: true, frequency: 'weekly' })
    weekly.env.advance(4 * DAY)
    expect(weekly.env.ctx.backups.warning()).toBeNull()
    weekly.env.advance(7 * DAY)
    expect(weekly.env.ctx.backups.warning()).toMatchObject({ kind: 'stale' })

    const off = await world()
    off.env.advance(30 * DAY)
    expect(off.env.ctx.backups.warning()).toBeNull()
  })

  /**
   * Inputs:   a schedule without a passphrase, and one without the folder
   * Expected: both refused
   */
  it('needs a passphrase and the folder', async () => {
    const w = await world({ passphrase: false })
    expect((await w.settings({}, { enabled: true })).body.error).toBe('passphrase_not_set')
    const x = await world()
    expect((await x.settings({ folderEnabled: false }, { enabled: true })).body.error).toBe(
      'folder_required',
    )
  })
})

describe('restore from Settings', () => {
  const send = async (w: Awaited<ReturnType<typeof world>>, bytes: Buffer) =>
    upload(w.env, w.admin.client, '/api/backups/restore/upload', bytes)
  const check = (w: Awaited<ReturnType<typeof world>>, uploadId: string, passphrase: string) =>
    w.admin.client.post('/api/backups/restore/check', { uploadId, passphrase })

  /**
   * Inputs:   a good backup uploaded; a wrong passphrase, then the right one; confirm without
   *           replaceEverything, then with it
   * Expected: the wrong passphrase keeps the upload; the summary shows the contents; only the
   *           explicit confirm takes a safety copy, writes the journal and asks to restart.
   *           Afterwards no backup or second restore can start. Live files are untouched.
   */
  it('checks first, and changes nothing until confirmed', async () => {
    const w = await world()
    const key = randomBytes(32)
    const bytes = await makeBackup({
      key,
      db: { secrets: [createCrypto(key).encrypt('totp')] },
    })
    const { uploadId } = (await send(w, bytes)).body
    expect((await check(w, uploadId, 'wrong passphrase!')).body.error).toBe('wrong_passphrase')
    const ok = await check(w, uploadId, BACKUP_PASSPHRASE)
    expect(ok.body.summary).toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
      counts: { users: 1, spaces: 2, accounts: 3, transactions: 40, files: 0 },
      warnings: [],
    })
    const sloppy = await w.admin.client.post('/api/backups/restore/confirm', { uploadId })
    expect(sloppy.status).toBe(400)
    expect(await exists(journalPath(w.env.paths))).toBe(false)

    const done = await w.admin.client.post('/api/backups/restore/confirm', {
      uploadId,
      replaceEverything: true,
    })
    expect(done.status).toBe(202)
    expect(w.env.restarts()).toBe(1)
    expect(await exists(journalPath(w.env.paths))).toBe(true)
    const safety = await fs.readdir(w.env.paths.safetyDir)
    expect(safety).toEqual([expect.stringMatching(/^restore-/)])
    expect(await exists(path.join(w.env.paths.safetyDir, safety[0]!, FILE))).toBe(true)
    expect(await fs.readFile(w.env.paths.keyPath)).toEqual(w.key)
    const after = await w.admin.client.post('/api/backups/run', { destination: 'download' })
    expect(after.body.error).toBe('restore_pending')
    expect((await send(w, bytes)).body.error).toBe('restore_pending')
  })

  /**
   * Inputs:   backups that are: from a newer schema; from a pad this Pond ships with a migration
   *           it doesn't know; with a secret under another key; with a damaged database; whose
   *           migration fails; whose files all fail to open
   * Expected: each refused with its own reason, leaving nothing staged
   */
  it('refuses a backup it could not safely restore', async () => {
    const w = await world()
    w.env.ctx.restores['d'].shippedPads = () =>
      new Map([['business', { name: 'Business', migrations: ['001'] }]])
    const cases: [string, Parameters<typeof makeBackup>[0]][] = [
      ['newer_backup', { db: { schemaVersion: 7 }, manifest: { schemaVersion: 7 } }],
      ['newer_backup', { db: { padMigrations: { business: ['001', '002'] } } }],
      ['key_mismatch', { db: { secrets: [createCrypto(randomBytes(32)).encrypt('x')] } }],
      ['damaged_backup', { db: { broken: true } }],
      ['damaged_backup', { db: { failsToMigrate: true } }],
      ['key_mismatch', { files: { [FILE]: randomBytes(64) } }],
    ]
    for (const [error, spec] of cases) {
      const { uploadId } = (await send(w, await makeBackup(spec))).body
      expect((await check(w, uploadId, BACKUP_PASSPHRASE)).body.error, error).toBe(error)
      const confirm = await w.admin.client.post('/api/backups/restore/confirm', {
        uploadId,
        replaceEverything: true,
      })
      expect(confirm.body.error).toBe('restore_expired')
      expect(await exists(path.join(w.env.paths.restoreDir, 'staging', uploadId))).toBe(false)
    }
    expect(w.env.restarts()).toBe(0)
  })

  /**
   * Inputs:   a backup holding data for an app this Pond doesn't ship, and one good and one
   *           unreadable file
   * Expected: allowed, with a warning for each
   */
  it('warns, without refusing, about an unknown app and a single bad file', async () => {
    const w = await world()
    const key = randomBytes(32)
    const bytes = await makeBackup({
      key,
      db: { padMigrations: { bills: ['001'] } },
      files: {
        'files/business/s1/good': createCrypto(key).encryptBytes(
          Buffer.from('a'),
          'pond-file:business/s1/good',
        ),
        'files/business/s1/bad': randomBytes(64),
      },
    })
    const { uploadId } = (await send(w, bytes)).body
    const res = await check(w, uploadId, BACKUP_PASSPHRASE)
    expect(res.body.summary.warnings).toEqual([
      expect.stringContaining('bills'),
      expect.stringContaining('1 of 2'),
    ])
  })

  /**
   * Inputs:   a file over the 5 MB test limit, and a disk reporting almost no free space
   * Expected: 413 too_large and 507 not_enough_space
   */
  it('refuses an upload that is too big or would not fit', async () => {
    const w = await world()
    // Called directly: supertest can't read an answer that arrives before its upload is sent.
    await expect(
      w.env.ctx.restores.receive(Readable.from([]), 6 * 1024 * 1024),
    ).rejects.toMatchObject({ code: 'too_large' })
    w.env.ctx.restores['d'].freeBytes = async () => 1000
    expect((await send(w, Buffer.alloc(100))).body.error).toBe('not_enough_space')
  })
})

describe('/api/setup/restore (a brand-new install)', () => {
  const fresh = async () => {
    const dataDir = await tempDir()
    made.push(dataDir)
    const env = makeEnv({ dataDir })
    await writeTree(dataDir, { 'keys/master.key': randomBytes(32) })
    return env
  }
  const code = (env: ReturnType<typeof makeEnv>) => ({
    'x-setup-code': env.ctx.setupCode.reveal()!,
  })

  /**
   * Inputs:   no setup code and a wrong one, on every first-run restore route
   * Expected: 403, and nothing is written
   */
  it('needs the setup code from the server console', async () => {
    for (const step of ['upload', 'check', 'confirm']) {
      for (const headers of [{}, { 'x-setup-code': 'AAAA-BBBB-CCCC' }] as const) {
        const env = await fresh() // a fresh one each time, so the rate limit stays out of the way
        const res = await upload(
          env,
          new Client(env.app),
          `/api/setup/restore/${step}`,
          Buffer.from('x'),
          headers as Record<string, string>,
        )
        expect(res.status, step).toBe(403)
        expect(await exists(env.paths.restoreDir)).toBe(false)
      }
    }
  })

  /**
   * Inputs:   the right setup code, a backup, its passphrase and the confirmation
   * Expected: the restore is marked ready (requested by no one) and Pond asks to restart
   */
  it('restores without any account', async () => {
    const env = await fresh()
    const anon = new Client(env.app)
    const up = await upload(env, anon, '/api/setup/restore/upload', await makeBackup(), code(env))
    expect(up.status).toBe(201)
    const post = (url: string, body: object) => request(env.app).post(url).set(code(env)).send(body)
    const checked = await post('/api/setup/restore/check', {
      uploadId: up.body.uploadId,
      passphrase: BACKUP_PASSPHRASE,
    })
    expect(checked.status).toBe(200)
    const done = await post('/api/setup/restore/confirm', {
      uploadId: up.body.uploadId,
      replaceEverything: true,
    })
    expect(done.status).toBe(202)
    expect(env.restarts()).toBe(1)
    expect(JSON.parse(await fs.readFile(journalPath(env.paths), 'utf8'))).toMatchObject({
      state: 'ready',
      requestedBy: null,
    })
  })

  /**
   * Inputs:   an install with an account, with the code still shown as active (a race), and after
   *           normal setup
   * Expected: 404 both ways; it is closed once any account exists
   */
  it('is closed once any account exists', async () => {
    const env = await fresh()
    const saved = code(env)
    await bootstrapAdmin(env)
    const res = await upload(
      env,
      new Client(env.app),
      '/api/setup/restore/upload',
      Buffer.from('x'),
      saved,
    )
    expect(res.status).toBe(404)
    const racing = await fresh()
    racing.ctx.repos.users.create({
      id: 'u',
      username: 'ann',
      displayName: 'Ann',
      passwordHash: 'h',
      isAdmin: true,
    })
    const second = await upload(
      racing,
      new Client(racing.app),
      '/api/setup/restore/upload',
      Buffer.from('x'),
      code(racing),
    )
    expect(second.status).toBe(404)
  })
})
