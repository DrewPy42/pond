import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { csrfMatches, hasRecentReauth, loadSession } from '../auth/sessions.js'
import type { Repos } from '../repos/types.js'
import { CSRF_COOKIE, SESSION_COOKIE, parseCookies, sendError } from '../http.js'
import type { Role } from '../types.js'

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 }
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Loads the session (if any) onto `req.auth`. Never rejects by itself. */
export function sessionMiddleware(repos: Repos, now: () => Date): RequestHandler {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (token) req.auth = loadSession(repos.sessions, token, now()) ?? undefined
    next()
  }
}

/**
 * Double-submit CSRF on state-changing requests that carry a session: the `x-csrf-token`
 * header must equal the CSRF cookie and match the hash stored with the session. SameSite=Strict
 * on the session cookie is the first line of defense; this is the second.
 */
export const csrfGuard: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method) || !req.auth) return next()
  const header = req.header('x-csrf-token')
  const cookie = parseCookies(req.headers.cookie)[CSRF_COOKIE]
  if (!header || header !== cookie || !csrfMatches(req.auth.csrfHash, header)) {
    return sendError(res, 403, 'csrf_failed')
  }
  next()
}

export interface RequireAuthOptions {
  /** Allow admins who have not finished TOTP enrollment (only the enrollment routes). */
  allowPendingTotp?: boolean
}

/** 401 without a session. Admins must have TOTP enabled (security.md) before doing anything. */
export function requireAuth(opts: RequireAuthOptions = {}): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) return sendError(res, 401, 'unauthenticated')
    if (req.auth.user.isAdmin && !req.auth.user.totpEnabled && !opts.allowPendingTotp) {
      return sendError(res, 403, 'totp_enrollment_required')
    }
    next()
  }
}

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.auth) return sendError(res, 401, 'unauthenticated')
  if (!req.auth.user.isAdmin) return sendError(res, 403, 'forbidden')
  next()
}

/**
 * The single place Space access is decided. Resolves `:spaceId` against `space_members`:
 *  - not a member (and not an admin), or no such Space: 404, so existence doesn't leak
 *  - member below `minRole`: 403
 *  - admin: treated as owner everywhere
 * Handlers read the result from `req.space`.
 */
export function requireSpace(repos: Repos, minRole: Role): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.auth
    if (!auth) return sendError(res, 401, 'unauthenticated')
    const spaceId = req.params.spaceId
    if (typeof spaceId !== 'string') return sendError(res, 404, 'not_found')

    // An archived Space is closed to everyone, administrators included, until it is restored.
    // This one check shuts every Space route, core and LilyPad alike.
    const space = repos.spaces.findById(spaceId)
    if (!space || space.archivedAt !== null) return sendError(res, 404, 'not_found')

    // Admins are owners everywhere; everyone else needs a membership row.
    const role: Role | undefined = auth.user.isAdmin
      ? 'owner'
      : repos.spaces.getRole(spaceId, auth.user.id)
    if (!role) return sendError(res, 404, 'not_found')
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) return sendError(res, 403, 'forbidden')
    req.space = { id: spaceId, role }
    next()
  }
}

/**
 * For the only routes that change things without an account: creating the first admin, and
 * restoring onto a new install (docs/simple-setup-design.md). They close as soon as any account
 * exists, checked on every request. They also refuse requests a browser marks as coming from
 * another origin, so no other website or app can use someone's browser to claim Pond. (Browsers
 * already won't send JSON or raw files across origins, since Pond never allows it.)
 */
export const firstRunOnly =
  (repos: Repos): RequestHandler =>
  (req, res, next) => {
    if (repos.users.count() > 0) return sendError(res, 404, 'not_found')
    // Sent by browsers over HTTPS and to localhost. Other clients don't send it.
    const site = req.header('sec-fetch-site')
    if (site !== undefined && site !== 'same-origin' && site !== 'none')
      return sendError(res, 403, 'cross_origin')
    next()
  }

/** For sensitive actions (reveals, backups, security settings): password re-entered < 5 min ago. */
export const requireRecentReauth =
  (now: () => Date): RequestHandler =>
  (req, res, next) => {
    if (!req.auth) return sendError(res, 401, 'unauthenticated')
    if (!hasRecentReauth(req.auth.reauthAt, now())) return sendError(res, 403, 'reauth_required')
    next()
  }
