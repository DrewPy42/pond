import { sql } from 'drizzle-orm'
import { createApp } from './app.js'
import { LoginLimiter } from './auth/ratelimit.js'
import { SetupCode } from './auth/setupCode.js'
import { loadConfig } from './config.js'
import { createCrypto, loadOrCreateMasterKey } from './crypto/index.js'
import { openDb, runMigrations } from './db/index.js'
import { users } from './db/schema.js'
import { createLogger } from './logger.js'

const config = loadConfig()
const log = createLogger(config.logLevel)

const crypto = createCrypto(loadOrCreateMasterKey(config.keyPath))
const db = openDb(config.dbPath)
runMigrations(db)

const userCount =
  db.db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .get()?.n ?? 0
const setupCode = new SetupCode(userCount === 0)
if (setupCode.active) {
  // Printed to the console on purpose: physical access to the server is the trust anchor.
  const code = setupCode.reveal()
  console.log(
    `\n  Pond first-run setup code: ${code}\n  Enter it in the browser to create the admin account.\n`,
  )
}

const app = createApp({
  db,
  crypto,
  log,
  setupCode,
  limiter: new LoginLimiter(),
  cookieSecure: config.cookieSecure,
  now: () => new Date(),
  spaceRoutes: [],
})
const server = app.listen(config.port, config.host, () => {
  log.info({ port: config.port, dataDir: config.dataDir }, 'Pond server listening')
})

function shutdown(signal: string) {
  log.info({ signal }, 'shutting down')
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
