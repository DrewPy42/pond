import { createApp, VERSION } from './app.js'
import { DEFAULT_WORK_FACTOR } from './backup/archive.js'
import { bootDatabase, finishRestore } from './backup/boot.js'
import { createGatedFileStore } from './backup/fileGate.js'
import { BackupLock } from './backup/lock.js'
import { backupPaths } from './backup/paths.js'
import { RestoreService } from './backup/restore.js'
import { createSafetyCopies } from './backup/safety.js'
import { BackupService } from './backup/service.js'
import { LoginLimiter } from './auth/ratelimit.js'
import { loadConfig } from './config.js'
import { createCrypto, loadOrCreateMasterKey } from './crypto/index.js'
import { newId } from './db/ids.js'
import { seedMissingCategories } from './ledger/service.js'
import { createDiskFileStore } from './files/store.js'
import { createEventBus } from './events.js'
import { PadHost } from './lilypads/host.js'
import { registrySource } from './lilypads/registry.js'
import { createLogger } from './logger.js'
import { createHttpSimpleFinClient } from './simplefin/client.js'
import { clampIntervalHours, startSyncScheduler } from './sync/scheduler.js'
import { syncAll } from './sync/service.js'
import { createSqliteBackupDb } from './repos/backupDb.js'
import { createDrizzleRepos } from './repos/drizzle.js'

const config = loadConfig()
const log = createLogger(config.logLevel)

const now = () => new Date()
const paths = backupPaths(config.dataDir, config.backupDir)

// First: a waiting restore replaces the database, key and files before anything opens them.
const booted = await bootDatabase(paths, now)
const db = booted.db
if (booted.restore.kind === 'rolled_back')
  log.error('The restore could not be applied. Pond is running with the data it had before.')

const crypto = createCrypto(loadOrCreateMasterKey(config.keyPath))
const repos = createDrizzleRepos(db)
finishRestore(booted.restore, { repos, paths, now, newId })
if (booted.restore.kind === 'swapped')
  log.info('A backup was restored. Everyone must sign in again.')

const backupDb = createSqliteBackupDb(db)
const files = createGatedFileStore(createDiskFileStore(config.filesDir, crypto))
const safety = createSafetyCopies({ db: backupDb, paths, now, gate: files })
// One safety copy covers all of a start's migrations; installing an app later takes its own.
let starting = true
let startCopyTaken = booted.safetyCopyTaken
seedMissingCategories({ repos, newId, now: () => new Date() }) // Spaces from before categories existed
if (repos.users.count() === 0)
  log.info('Pond has no account yet. Open it in a browser to set it up.')

const simplefin = createHttpSimpleFinClient()
const events = createEventBus((e, ev) =>
  log.error(
    { err: { name: (e as Error)?.name, message: (e as Error)?.message }, event: ev.type },
    'event listener failed',
  ),
)
const padHost = new PadHost({
  repos,
  crypto,
  log,
  now: () => new Date(),
  newId,
  timeZone: config.timeZone,
  events,
  source: registrySource,
  files,
  includeDevPads: config.devPads,
  beforeMigrate: async () => {
    if (starting && startCopyTaken) return
    await safety.beforeMigration()
    startCopyTaken = true
  },
})

await padHost.start() // loads installed pads (migrates and registers) before taking requests
starting = false

const lock = new BackupLock()
const backups = new BackupService({
  repos,
  crypto,
  db: backupDb,
  paths,
  gate: files,
  lock,
  now,
  newId,
  timeZone: config.timeZone,
  pondVersion: VERSION,
  workFactor: DEFAULT_WORK_FACTOR,
})
const restores = new RestoreService({
  db: backupDb,
  paths,
  lock,
  safety,
  newId,
  maxUploadBytes: config.restoreMaxBytes,
  shippedPads: () =>
    new Map(
      registrySource
        .list()
        .filter((m) => !m.manifest.devOnly || config.devPads)
        .map((m) => [
          m.manifest.id,
          { name: m.manifest.name, migrations: m.migrations.map((x) => x.name) },
        ]),
    ),
})

const app = createApp({
  repos,
  crypto,
  log,
  limiter: new LoginLimiter(),
  cookieSecure: config.cookieSecure,
  now: () => new Date(),
  newId,
  events,
  padHost,
  simplefin,
  timeZone: config.timeZone,
  backups,
  restores,
  restart: () => {
    log.warn('Stopping to apply a restore. If Pond does not come back by itself, start it again.')
    setTimeout(() => shutdown('restore'), 500)
  },
  spaceRoutes: [],
  webDir: config.webDir,
  hsts: config.hsts,
})
const server = app.listen(config.port, config.host, () => {
  log.info({ port: config.port, dataDir: config.dataDir }, 'Pond server listening')
})

const scheduler = startSyncScheduler({
  run: async () => {
    const results = await syncAll({
      repos,
      newId,
      now: () => new Date(),
      crypto,
      client: simplefin,
      timeZone: config.timeZone,
    })
    for (const [id, r] of Object.entries(results)) {
      // Counts only: never the Access URL or bank data.
      log.info(
        {
          connection: id,
          ok: r.ok,
          inserted: r.inserted,
          updated: r.updated,
          removed: r.removed,
          warnings: r.warnings.length,
        },
        'bank sync finished',
      )
    }
  },
  intervalMs: clampIntervalHours(config.syncIntervalHours ?? Number.NaN) * 3_600_000,
  onError: (e) =>
    log.error(
      { err: { name: (e as Error)?.name, message: (e as Error)?.message } },
      'bank sync crashed',
    ),
})

const padJobs = startSyncScheduler({
  run: () => padHost.runDueJobs(),
  intervalMs: 15 * 60_000,
  firstDelayMs: 30_000,
  onError: (e) =>
    log.error(
      { err: { name: (e as Error)?.name, message: (e as Error)?.message } },
      'LilyPad job run crashed',
    ),
})

// A large backup uploaded over Wi-Fi can take longer than Node's 5-minute default.
server.requestTimeout = 60 * 60_000

const backupSchedule = startSyncScheduler({
  run: () => backups.runDue(),
  intervalMs: 5 * 60_000,
  firstDelayMs: 60_000,
  onError: (e) =>
    log.error(
      { err: { name: (e as Error)?.name, message: (e as Error)?.message } },
      'scheduled backup failed',
    ),
})

function shutdown(signal: string) {
  padJobs.stop()
  backupSchedule.stop()
  log.info({ signal }, 'shutting down')
  scheduler.stop()
  server.close(() => {
    db.close()
    process.exit(0)
  })
  // Browsers keep connections open; don't wait for them for ever.
  setTimeout(() => server.closeAllConnections(), 5_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
