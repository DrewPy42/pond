import type { Logger } from 'pino'
import type { LoginLimiter } from './auth/ratelimit.js'
import type { SetupCode } from './auth/setupCode.js'
import type { Crypto } from './crypto/index.js'
import type { DbHandle } from './db/index.js'
import type { SpaceRouteInfo } from './middleware/spaceRouter.js'

export interface AppContext {
  db: DbHandle
  crypto: Crypto
  log: Logger
  setupCode: SetupCode
  limiter: LoginLimiter
  /** `Secure` flag on cookies. True in production; off for plain-HTTP local development. */
  cookieSecure: boolean
  now: () => Date
  /** Filled in as Space-scoped routes are declared; used by the permission tests. */
  spaceRoutes: SpaceRouteInfo[]
}
