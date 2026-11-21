import path from 'node:path'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3210),
  HOST: z.string().default('0.0.0.0'),
  /** Everything persistent lives here: pond.db, keys/, files/, backups/ (see architecture.md). */
  POND_DATA_DIR: z.string().default('./data'),
  /** Secure cookies. Defaults on in production; set false for plain-HTTP local dev. */
  POND_COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export type Config = ReturnType<typeof loadConfig>

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = envSchema.parse(env)
  const dataDir = path.resolve(e.POND_DATA_DIR)
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    cookieSecure: e.POND_COOKIE_SECURE
      ? e.POND_COOKIE_SECURE === 'true'
      : e.NODE_ENV === 'production',
    dataDir,
    dbPath: path.join(dataDir, 'pond.db'),
    keyPath: path.join(dataDir, 'keys', 'master.key'),
  }
}
