import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createCrypto, loadOrCreateMasterKey } from './crypto/index.js'
import { openDb, runMigrations } from './db/index.js'
import { createLogger } from './logger.js'

const config = loadConfig()
const log = createLogger(config.logLevel)

const crypto = createCrypto(loadOrCreateMasterKey(config.keyPath))
const db = openDb(config.dbPath)
runMigrations(db)

const app = createApp({ db, crypto, log })
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
