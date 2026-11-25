import type { Logger } from 'pino'
import type { LoginLimiter } from './auth/ratelimit.js'
import type { SetupCode } from './auth/setupCode.js'
import type { Crypto } from './crypto/index.js'
import type { SpaceRouteInfo } from './middleware/spaceRouter.js'
import type { Repos } from './repos/types.js'
import type { EventBus } from './events.js'
import type { PadHost } from './lilypads/host.js'
import type { RestoreService } from './backup/restore.js'
import type { BackupService } from './backup/service.js'
import type { SimpleFinClient } from './simplefin/types.js'

export interface AppContext {
  /** All data access. Real (Drizzle) in production, in-memory fakes in tests. */
  repos: Repos
  crypto: Crypto
  log: Logger
  setupCode: SetupCode
  limiter: LoginLimiter
  /** `Secure` flag on cookies. True in production; off for plain-HTTP local development. */
  cookieSecure: boolean
  now: () => Date
  /** Announces core changes to LilyPads, after they are committed. */
  events: EventBus
  /** Loads and runs LilyPads (docs/lilypad-host-design.md). */
  padHost: PadHost
  /** The only door to SimpleFIN: real HTTP in production, a scripted fake in tests. */
  simplefin: SimpleFinClient
  /** IANA time zone for turning bank timestamps into calendar days. */
  timeZone: string
  /** Generates primary keys (UUIDv7 in production, predictable in tests). */
  newId: () => string
  /** Making backups, on request and on a schedule. */
  backups: BackupService
  /** Receiving and checking a backup to restore (docs/backup-design.md). */
  restores: RestoreService
  /** Stops Pond so a confirmed restore is applied at the next start. */
  restart: () => void
  /** Filled in as Space-scoped routes are declared; used by the permission tests. */
  spaceRoutes: SpaceRouteInfo[]
}
