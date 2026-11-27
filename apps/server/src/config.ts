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
  /** IANA zone used to turn bank timestamps into calendar days. Defaults to this machine's zone. */
  POND_TIMEZONE: z.string().optional(),
  /** How often bank data is pulled (hours). Clamped to 4..24; SimpleFIN refreshes about daily. */
  POND_SYNC_INTERVAL_HOURS: z.coerce.number().optional(),
  /** The built web app to serve. The production image sets it; development uses Vite instead. */
  POND_WEB_DIR: z.string().optional(),
  /** Offer the template LilyPad (development only). */
  POND_DEV_PADS: z.enum(['true', 'false']).optional(),
  /** The one folder backups may be written to (a NAS share or USB drive mounted by Docker). */
  POND_BACKUP_DIR: z.string().optional(),
  /** Full path to rclone, for backups to online storage. Unset: that option is unavailable. */
  POND_RCLONE_PATH: z.string().optional(),
  /** Largest backup file a restore accepts, in MB. */
  POND_RESTORE_MAX_MB: z.coerce.number().int().min(1).max(1_000_000).default(2048),
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
    devPads: e.POND_DEV_PADS === 'true' && e.NODE_ENV !== 'production',
    timeZone: e.POND_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    syncIntervalHours: e.POND_SYNC_INTERVAL_HOURS,
    cookieSecure: e.POND_COOKIE_SECURE
      ? e.POND_COOKIE_SECURE === 'true'
      : e.NODE_ENV === 'production',
    webDir: e.POND_WEB_DIR ? path.resolve(e.POND_WEB_DIR) : null,
    dataDir,
    dbPath: path.join(dataDir, 'pond.db'),
    filesDir: path.join(dataDir, 'files'),
    keyPath: path.join(dataDir, 'keys', 'master.key'),
    backupDir: e.POND_BACKUP_DIR ? path.resolve(e.POND_BACKUP_DIR) : null,
    rclonePath: e.POND_RCLONE_PATH ? path.resolve(e.POND_RCLONE_PATH) : null,
    restoreMaxBytes: e.POND_RESTORE_MAX_MB * 1024 * 1024,
  }
}
