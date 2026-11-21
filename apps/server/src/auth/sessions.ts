import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, ne } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { sessions, users } from '../db/schema.js'

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
  db: Db,
  userId: string,
  meta: { ip?: string; userAgent?: string },
  now: Date = new Date(),
): NewSession {
  const token = newToken()
  const csrfToken = newToken()
  const expiresAt = new Date(now.getTime() + IDLE_TIMEOUT_MS)
  db.insert(sessions)
    .values({
      id: sha256(token),
      userId,
      csrfHash: sha256(csrfToken),
      expiresAt: expiresAt.toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS).toISOString(),
      lastSeenAt: now.toISOString(),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
    })
    .run()
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
export function loadSession(db: Db, token: string, now: Date = new Date()): SessionUser | null {
  const id = sha256(token)
  const row = db
    .select({
      s: sessions,
      u: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isAdmin: users.isAdmin,
        status: users.status,
        totpEnabledAt: users.totpEnabledAt,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get()
  if (!row) return null
  const expired = new Date(row.s.expiresAt) <= now || new Date(row.s.absoluteExpiresAt) <= now
  if (expired || row.u.status !== 'active') {
    db.delete(sessions).where(eq(sessions.id, id)).run()
    return null
  }
  const slid = new Date(
    Math.min(now.getTime() + IDLE_TIMEOUT_MS, new Date(row.s.absoluteExpiresAt).getTime()),
  )
  db.update(sessions)
    .set({ lastSeenAt: now.toISOString(), expiresAt: slid.toISOString() })
    .where(eq(sessions.id, id))
    .run()
  return {
    sessionId: id,
    csrfHash: row.s.csrfHash,
    reauthAt: row.s.reauthAt,
    user: {
      id: row.u.id,
      username: row.u.username,
      displayName: row.u.displayName,
      isAdmin: row.u.isAdmin,
      totpEnabled: row.u.totpEnabledAt !== null,
    },
  }
}

export function csrfMatches(csrfHash: string, presented: string | undefined): boolean {
  if (!presented) return false
  const a = Buffer.from(sha256(presented))
  const b = Buffer.from(csrfHash)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const revokeSession = (db: Db, sessionId: string): void => {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run()
}

/** Used on password change and when an admin disables a user. */
export function revokeUserSessions(db: Db, userId: string, exceptSessionId?: string): void {
  db.delete(sessions)
    .where(
      exceptSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
        : eq(sessions.userId, userId),
    )
    .run()
}

export function markReauth(db: Db, sessionId: string, now: Date = new Date()): void {
  db.update(sessions).set({ reauthAt: now.toISOString() }).where(eq(sessions.id, sessionId)).run()
}

export function hasRecentReauth(reauthAt: string | null, now: Date = new Date()): boolean {
  return reauthAt !== null && now.getTime() - new Date(reauthAt).getTime() <= REAUTH_WINDOW_MS
}
