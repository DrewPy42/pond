import type { SessionUser } from './auth/sessions.js'

export type Role = 'owner' | 'editor' | 'viewer'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the session middleware when a valid session cookie is presented. */
      auth?: SessionUser
      /** Set by the Space middleware: the caller's effective role in `:spaceId`. */
      space?: { id: string; role: Role }
    }
  }
}
