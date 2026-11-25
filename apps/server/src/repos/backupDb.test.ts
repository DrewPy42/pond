/**
 * Backup and restore against real SQLite: the round trip, older schemas, safety copies and the
 * start-up sequence (docs/backup-design.md, "Tests"). Everything lives in temporary folders.
 */
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { collectOps } from '@pond/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { bootDatabase, finishRestore } from '../backup/boot.js'
import { createBackupFile } from '../backup/create.js'
import { createGatedFileStore } from '../backup/fileGate.js'
import { BackupLock } from '../backup/lock.js'
import { backupPaths, type BackupPaths } from '../backup/paths.js'
import { RestoreService } from '../backup/restore.js'
import { SAFETY_KEEP, createSafetyCopies } from '../backup/safety.js'
import { createCrypto, loadOrCreateMasterKey } from '../crypto/index.js'
import { SCHEMA_FIXTURES } from '../db/fixtures.js'
import { latestSchemaVersion, openDb, schemaVersion, type DbHandle } from '../db/index.js'
import { migrateToVersion } from '../db/migrationTesting.js'
import { createDiskFileStore } from '../files/store.js'
import { registrySource } from '../lilypads/registry.js'
import { BACKUP_PASSPHRASE, readTree, tempDir } from '../testing/backupWorld.js'
import { createSqliteBackupDb } from './backupDb.js'
import { createDrizzleRepos } from './drizzle.js'
import { createSqlitePadStore } from './padStore.js'

const made: string[] = []
const open: DbHandle[] = []
afterEach(async () => {
  for (const h of open.splice(0)) if (h.sqlite.open) h.close()
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

const now = () => new Date('2030-01-02T03:04:05Z')
let ids = 0
const newId = () => `restore-${++ids}`

const install = async (): Promise<BackupPaths> => {
  const dir = await tempDir()
  made.push(dir)
  return backupPaths(path.join(dir, 'data'))
}
const boot = async (paths: BackupPaths, migrate?: (db: DbHandle) => void) => {
  const booted = await bootDatabase(paths, now, migrate)
  open.push(booted.db)
  return booted
}

/** Every row of every table, to compare two databases exactly. */
const dump = (db: DbHandle) => {
  const tables = db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[]
  return Object.fromEntries(
    tables.map((t) => [t.name, db.sqlite.prepare(`SELECT * FROM "${t.name}" ORDER BY 1, 2`).all()]),
  )
}

/** Back up `source`, restore it into `target` as the app does, and stop before the restart. */
async function backupAndStage(source: BackupPaths, db: DbHandle, target: BackupPaths) {
  const file = path.join(source.dataDir, '..', 'made.pond')
  await createBackupFile({
    db: createSqliteBackupDb(db),
    paths: source,
    gate: { hold: () => () => {} },
    passphrase: BACKUP_PASSPHRASE,
    workFactor: 10,
    instanceId: 'abc',
    pondVersion: '0.0.0',
    createdAt: now(),
    target: file,
  })
  const running = await boot(target)
  loadOrCreateMasterKey(target.keyPath)
  const restores = new RestoreService({
    db: createSqliteBackupDb(running.db),
    paths: target,
    lock: new BackupLock(),
    safety: createSafetyCopies({ db: createSqliteBackupDb(running.db), paths: target, now }),
    newId,
    maxUploadBytes: 1 << 30,
    shippedPads: () =>
      new Map(
        registrySource
          .list()
          .map((m) => [
            m.manifest.id,
            { name: m.manifest.name, migrations: m.migrations.map((x) => x.name) },
          ]),
      ),
  })
  const size = (await fs.stat(file)).size
  const { uploadId } = await restores.receive(createReadStream(file) as Readable, size)
  const summary = await restores.check(uploadId, BACKUP_PASSPHRASE)
  await restores.confirm(uploadId, 'ann')
  running.db.close()
  return summary
}

/** An install with an admin, secrets, a Space, the Business app's data and a stored file. */
async function populated() {
  const paths = await install()
  const { db } = await boot(paths)
  const crypto = createCrypto(loadOrCreateMasterKey(paths.keyPath))
  const repos = createDrizzleRepos(db)
  repos.users.create({
    id: 'u1',
    username: 'ann',
    displayName: 'Ann',
    passwordHash: 'hash',
    isAdmin: true,
  })
  repos.users.update('u1', { totpSecretEnc: crypto.encrypt('TOTPSECRET') })
  repos.spaces.create({ id: 's1', name: 'Shop', type: 'business', currency: 'USD' })
  repos.settings.set('global', '', 'backup.passphrase', crypto.encrypt(BACKUP_PASSPHRASE))
  repos.sessions.create({
    id: 'sess',
    userId: 'u1',
    csrfHash: 'c',
    expiresAt: '2031-01-01T00:00:00Z',
    absoluteExpiresAt: '2031-01-01T00:00:00Z',
    lastSeenAt: '2030-01-01T00:00:00Z',
    ip: null,
    userAgent: null,
  })
  const business = registrySource.list().find((p) => p.manifest.id === 'business')!
  const store = createSqlitePadStore(db.sqlite, { newId: () => 'row-1', now })
  for (const m of business.migrations) {
    store.applyOps('business', collectOps(m))
    repos.pads.migrations.record('business', m.name, now().toISOString())
  }
  db.sqlite
    .prepare(
      "INSERT INTO lp_business_people (id, space_id, first_name, last_name, relationship, tax_id_enc, created_at, updated_at) VALUES ('p1', 's1', 'Pat', 'Doe', 'employee', ?, 'a', 'a')",
    )
    .run(crypto.encrypt('123-45-6789'))
  const files = createGatedFileStore(createDiskFileStore(paths.filesDir, crypto))
  const ref = { padId: 'business', spaceId: 's1', fileId: 'doc1' }
  await files.put(ref, Buffer.from('a receipt'))
  return { paths, db, crypto, repos, ref }
}

describe('backup then restore on real SQLite', () => {
  /**
   * Function: createBackupFile, RestoreService, bootDatabase, finishRestore
   * Inputs:   a populated install (users, encrypted TOTP, passphrase and tax ID, an app's tables,
   *           a stored file, a session) restored onto a brand-new install with its own key
   * Expected: every table and file matches, every encrypted value and file opens with the
   *           restored key, everyone is signed out and the restore is in the restored audit log
   */
  it('brings back every table, file and secret onto an empty install', async () => {
    const source = await populated()
    const before = dump(source.db)
    const target = await install()
    const summary = await backupAndStage(source.paths, source.db, target)
    expect(summary.counts).toMatchObject({ users: 1, spaces: 1, files: 1 })

    const booted = await boot(target)
    expect(booted.restore.kind).toBe('swapped')
    expect(dump(booted.db)).toEqual(before)
    expect(await readTree(target.filesDir)).toEqual(await readTree(source.paths.filesDir))
    expect(await fs.readFile(target.keyPath)).toEqual(await fs.readFile(source.paths.keyPath))

    const crypto = createCrypto(loadOrCreateMasterKey(target.keyPath))
    for (const value of createSqliteBackupDb(booted.db).encryptedValues(target.dbPath))
      expect(() => crypto.decrypt(value)).not.toThrow()
    expect([...createSqliteBackupDb(null).encryptedValues(target.dbPath)]).toHaveLength(3)
    expect(await createDiskFileStore(target.filesDir, crypto).get(source.ref)).toEqual(
      Buffer.from('a receipt'),
    )

    const repos = createDrizzleRepos(booted.db)
    finishRestore(booted.restore, { repos, paths: target, now, newId })
    expect(repos.sessions.findWithUser('sess')).toBeUndefined()
    expect(repos.audit.list({ limit: 1 })[0]).toMatchObject({
      action: 'backup.restored',
      meta: { requestedBy: 'ann' },
    })
    await expect(fs.stat(target.restoreDir)).rejects.toThrow()
  })

  /**
   * Function: restore of each earlier schema version
   * Inputs:   a backup of a database at schema version N, seeded with that version's fixture
   * Expected: it restores, migrates to the latest schema, and the fixture's data is intact
   */
  it.each(SCHEMA_FIXTURES.map((f) => [f.version, f] as const))(
    'restores and upgrades a backup from schema version %i',
    async (version, fixture) => {
      const paths = await install()
      await fs.mkdir(paths.dataDir, { recursive: true })
      const old = openDb(paths.dbPath)
      open.push(old)
      migrateToVersion(old, version)
      fixture.seed(old.sqlite)
      // The fixtures use placeholder secrets; a real backup's open with its key.
      const crypto = createCrypto(loadOrCreateMasterKey(paths.keyPath))
      const placeholders: [string, string, string][] = []
      for (const [table, column] of [
        ['connections', 'access_url_enc'],
        ['users', 'totp_secret_enc'],
      ] as const) {
        try {
          const rows = old.sqlite
            .prepare(`SELECT id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`)
            .all() as { id: string; v: string }[]
          for (const r of rows) {
            placeholders.push([table, column, r.v])
            old.sqlite
              .prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
              .run(crypto.encrypt(r.v), r.id)
          }
        } catch {
          // This table doesn't exist yet at this version.
        }
      }
      const target = await install()
      await backupAndStage(paths, old, target)

      const booted = await boot(target)
      expect(booted.restore.kind).toBe('swapped')
      expect(schemaVersion(booted.db)).toBe(latestSchemaVersion())
      const restored = createCrypto(loadOrCreateMasterKey(target.keyPath))
      for (const [table, column, plain] of placeholders) {
        const row = booted.db.sqlite
          .prepare(`SELECT id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`)
          .get() as { id: string; v: string }
        expect(restored.decrypt(row.v)).toBe(plain)
        booted.db.sqlite
          .prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
          .run(plain, row.id)
      }
      fixture.verify(booted.db.sqlite)
    },
  )

  /**
   * Function: bootDatabase when the restored database can't be migrated
   * Inputs:   a staged restore, and a migration step that fails the first time only
   * Expected: the old install comes back exactly, reported as rolled back and audited
   */
  it('puts the old data back if the restored database will not open', async () => {
    const source = await populated()
    const target = await install()
    const first = await boot(target)
    createDrizzleRepos(first.db).spaces.create({
      id: 'keep',
      name: 'Mine',
      type: 'personal',
      currency: 'USD',
    })
    const mine = dump(first.db)
    first.db.close()
    await backupAndStage(source.paths, source.db, target)
    const key = await fs.readFile(target.keyPath)

    let calls = 0
    const booted = await boot(target, () => {
      if (++calls === 1) throw new Error('migration failed')
    })
    expect(booted.restore.kind).toBe('rolled_back')
    expect(dump(booted.db)).toEqual(mine)
    expect(await fs.readFile(target.keyPath)).toEqual(key)
    const repos = createDrizzleRepos(booted.db)
    finishRestore(booted.restore, { repos, paths: target, now, newId })
    expect(repos.audit.list({ limit: 1 })[0]!.action).toBe('backup.restore_failed')
  })
})

describe('safety copies', () => {
  const olderInstall = async () => {
    const paths = await install()
    await fs.mkdir(paths.dataDir, { recursive: true })
    const db = openDb(paths.dbPath)
    migrateToVersion(db, 2)
    SCHEMA_FIXTURES[1]!.seed(db.sqlite)
    db.close()
    return paths
  }

  /**
   * Function: bootDatabase on an older install
   * Inputs:   a database at schema version 2
   * Expected: a copy still at version 2 is saved first (readable only by Pond), then it migrates;
   *           a second start makes no new copy
   */
  it('are taken before an existing database is migrated', async () => {
    const paths = await olderInstall()
    const booted = await boot(paths)
    expect(booted.safetyCopyTaken).toBe(true)
    expect(schemaVersion(booted.db)).toBe(latestSchemaVersion())
    const [name] = await fs.readdir(paths.safetyDir)
    const copy = path.join(paths.safetyDir, name!, 'pond.db')
    expect(createSqliteBackupDb(null).inspect(copy).schemaVersion).toBe(2)
    expect((await fs.stat(copy)).mode & 0o077).toBe(0)
    booted.db.close()
    expect((await boot(paths)).safetyCopyTaken).toBe(false)
    expect(await fs.readdir(paths.safetyDir)).toHaveLength(1)
  })

  /**
   * Function: bootDatabase when the safety copy can't be written
   * Inputs:   a version 2 database, with a plain file where the safety folder should be
   * Expected: the start fails and the database is still at version 2, never changed unprotected
   */
  it('stop the migration if they fail', async () => {
    const paths = await olderInstall()
    await fs.writeFile(paths.safetyDir, 'in the way')
    await expect(boot(paths)).rejects.toMatchObject({ code: 'safety_copy_failed' })
    expect(createSqliteBackupDb(null).inspect(paths.dbPath).schemaVersion).toBe(2)
  })

  /**
   * Function: createSafetyCopies(...).beforeMigration() and beforeRestore()
   * Inputs:   seven copies before migrations and one before a restore
   * Expected: five of the first kind remain (the newest) and the other kind is untouched
   */
  it('keep the last five of each kind', async () => {
    const paths = await install()
    const { db } = await boot(paths)
    loadOrCreateMasterKey(paths.keyPath)
    let second = 0
    const safety = createSafetyCopies({
      db: createSqliteBackupDb(db),
      paths,
      now: () => new Date(Date.UTC(2030, 0, 1, 0, 0, ++second)),
    })
    await safety.beforeRestore()
    const copies: string[] = []
    for (let i = 0; i < 7; i++) copies.push(path.basename(await safety.beforeMigration()))
    const left = await fs.readdir(paths.safetyDir)
    expect(left.filter((n) => n.startsWith('migration-')).sort()).toEqual(
      copies.slice(-SAFETY_KEEP),
    )
    expect(left.filter((n) => n.startsWith('restore-'))).toHaveLength(1)
  })
})

describe('createSqliteBackupDb(live).integrityProblems(path)', () => {
  /**
   * Inputs:   a sound database, a row pointing at a missing parent, and random bytes
   * Expected: no problems for the first; problems for the other two
   */
  it('finds broken references and files that are not databases', async () => {
    const paths = await install()
    const { db } = await boot(paths)
    const check = createSqliteBackupDb(db)
    const copy = path.join(paths.dataDir, 'copy.db')
    await check.snapshot(copy)
    expect(check.integrityProblems(copy)).toEqual([])
    db.sqlite.pragma('foreign_keys = OFF')
    db.sqlite.exec(
      "INSERT INTO space_members (space_id, user_id, role) VALUES ('no', 'one', 'owner')",
    )
    const broken = path.join(paths.dataDir, 'broken.db')
    await check.snapshot(broken)
    expect(check.integrityProblems(broken).length).toBeGreaterThan(0)
    const junk = path.join(paths.dataDir, 'junk.db')
    await fs.writeFile(junk, randomBytes(4096))
    expect(check.integrityProblems(junk).length).toBeGreaterThan(0)
  })
})
