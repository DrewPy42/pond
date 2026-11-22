import { createApp } from './app.js'
import { LoginLimiter } from './auth/ratelimit.js'
import { SetupCode } from './auth/setupCode.js'
import { loadConfig } from './config.js'
import { createCrypto, loadOrCreateMasterKey } from './crypto/index.js'
import { openDb, runMigrations } from './db/index.js'
import { newId } from './db/ids.js'
import { seedMissingCategories } from './ledger/service.js'
import { createLogger } from './logger.js'
import { createHttpSimpleFinClient } from './simplefin/client.js'
import { clampIntervalHours, startSyncScheduler } from './sync/scheduler.js'
import { syncAll } from './sync/service.js'
import { createDrizzleRepos } from './repos/drizzle.js'

const config = loadConfig()
const log = createLogger(config.logLevel)

const crypto = createCrypto(loadOrCreateMasterKey(config.keyPath))
const db = openDb(config.dbPath)
runMigrations(db)

const repos = createDrizzleRepos(db)
seedMissingCategories({ repos, newId, now: () => new Date() }) // Spaces from before categories existed
const setupCode = new SetupCode(repos.users.count() === 0)
if (setupCode.active) {
  // Printed to the console on purpose: physical access to the server is the trust anchor.
  const code = setupCode.reveal()
  console.log(
    `\n  Pond first-run setup code: ${code}\n  Enter it in the browser to create the admin account.\n`,
  )
}

const simplefin = createHttpSimpleFinClient()

const app = createApp({
  repos,
  crypto,
  log,
  setupCode,
  limiter: new LoginLimiter(),
  cookieSecure: config.cookieSecure,
  now: () => new Date(),
  newId,
  simplefin,
  timeZone: config.timeZone,
  spaceRoutes: [],
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

function shutdown(signal: string) {
  log.info({ signal }, 'shutting down')
  scheduler.stop()
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
