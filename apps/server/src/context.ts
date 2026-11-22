import type { Logger } from 'pino'
import type { LoginLimiter } from './auth/ratelimit.js'
import type { SetupCode } from './auth/setupCode.js'
import type { Crypto } from './crypto/index.js'
import type { SpaceRouteInfo } from './middleware/spaceRouter.js'
import type { Repos } from './repos/types.js'

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
  /** Generates primary keys (UUIDv7 in production, predictable in tests). */
  newId: () => string
  /** Filled in as Space-scoped routes are declared; used by the permission tests. */
  spaceRoutes: SpaceRouteInfo[]
}
