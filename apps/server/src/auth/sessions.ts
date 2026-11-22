import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SessionRepo } from '../repos/types.js'

export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000
export const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000
export const REAUTH_WINDOW_MS = 5 * 60 * 1000

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const newToken = (): string => randomBytes(32).toString('base64url') // 256 bits

export interface NewSession {
  token: string
  csrfToken: string
  expiresAt: Date
}

export function createSession(
  repo: SessionRepo,
  userId: string,
  meta: { ip?: string; userAgent?: string },
  now: Date = new Date(),
): NewSession {
  const token = newToken()
  const csrfToken = newToken()
  const expiresAt = new Date(now.getTime() + IDLE_TIMEOUT_MS)
  repo.create({
    id: sha256(token),
    userId,
    csrfHash: sha256(csrfToken),
    expiresAt: expiresAt.toISOString(),
    absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS).toISOString(),
    lastSeenAt: now.toISOString(),
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 255) ?? null,
  })
  return { token, csrfToken, expiresAt }
}

export interface SessionUser {
  sessionId: string
  csrfHash: string
  reauthAt: string | null
  user: {
    id: string
    username: string
    displayName: string
    isAdmin: boolean
    totpEnabled: boolean
  }
}

/** Resolve a cookie token to a live session and active user, sliding the idle window. */
export function loadSession(
  repo: SessionRepo,
  token: string,
  now: Date = new Date(),
): SessionUser | null {
  const id = sha256(token)
  const found = repo.findWithUser(id)
  if (!found) return null
  const { session, user } = found
  const expired = new Date(session.expiresAt) <= now || new Date(session.absoluteExpiresAt) <= now
  if (expired || user.status !== 'active') {
    repo.delete(id)
    return null
  }
  const slid = new Date(
    Math.min(now.getTime() + IDLE_TIMEOUT_MS, new Date(session.absoluteExpiresAt).getTime()),
  )
  repo.touch(id, now.toISOString(), slid.toISOString())
  return {
    sessionId: id,
    csrfHash: session.csrfHash,
    reauthAt: session.reauthAt,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
      totpEnabled: user.totpEnabledAt !== null,
    },
  }
}

export function csrfMatches(csrfHash: string, presented: string | undefined): boolean {
  if (!presented) return false
  const a = Buffer.from(sha256(presented))
  const b = Buffer.from(csrfHash)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const revokeSession = (repo: SessionRepo, sessionId: string): void => repo.delete(sessionId)

/** Used on password change and when an admin disables a user. */
export const revokeUserSessions = (
  repo: SessionRepo,
  userId: string,
  exceptSessionId?: string,
): void => repo.deleteForUser(userId, exceptSessionId)

export const markReauth = (repo: SessionRepo, sessionId: string, now: Date = new Date()): void =>
  repo.setReauth(sessionId, now.toISOString())

export function hasRecentReauth(reauthAt: string | null, now: Date = new Date()): boolean {
  return reauthAt !== null && now.getTime() - new Date(reauthAt).getTime() <= REAUTH_WINDOW_MS
}
