import { Router } from 'express'
import { z } from 'zod'
import { recordAudit } from '../audit.js'
import { clearSessionCookies, setSessionCookies } from '../auth/cookies.js'
import {
  checkPasswordStrength,
  hashPassword,
  verifyAgainstDummy,
  verifyPassword,
} from '../auth/password.js'
import { createSession, markReauth, revokeSession, revokeUserSessions } from '../auth/sessions.js'
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  newTotpSecret,
  totpUri,
  verifyTotp,
} from '../auth/totp.js'
import type { AppContext } from '../context.js'
import { h, sendError, validateBody } from '../http.js'
import { firstRunOnly, requireAuth } from '../middleware/auth.js'

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, '3-32 characters: letters, numbers, dot, dash, underscore')
const displayNameSchema = z.string().trim().min(1).max(80)
// Length limit protects Argon2 from huge inputs; strength is checked separately.
const passwordSchema = z.string().max(256)

export function publicUser(u: {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
  totpEnabled: boolean
}) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    isAdmin: u.isAdmin,
    totpEnabled: u.totpEnabled,
  }
}

export function authRouter(ctx: AppContext): Router {
  const r = Router()
  const { repos } = ctx
  const ip = (req: { ip?: string }) => req.ip ?? 'unknown'
  const meta = (req: { ip?: string; headers: { 'user-agent'?: string } }) => ({
    ip: ip(req),
    userAgent: req.headers['user-agent'],
  })
  const audit = (entry: Parameters<typeof recordAudit>[1]) =>
    recordAudit(repos.audit, entry, ctx.now(), ctx.newId)

  // ----- First run -----

  r.get('/setup/status', (_req, res) => {
    res.json({ setupRequired: repos.users.count() === 0 })
  })

  const setupBody = z.object({
    username: usernameSchema,
    displayName: displayNameSchema,
    password: passwordSchema,
  })
  r.post(
    '/setup',
    firstRunOnly(repos),
    validateBody(setupBody),
    h(async (req, res) => {
      const body = req.body as z.infer<typeof setupBody>
      const problem = checkPasswordStrength(body.password, body.username)
      if (problem) return sendError(res, 400, 'weak_password', { reason: problem })

      const passwordHash = await hashPassword(body.password)
      const id = ctx.newId()
      // Atomic "only if there are no users yet", so two racing requests can't both create an admin.
      const created = repos.transaction(() => {
        const ok = repos.users.createIfNoUsers({
          id,
          username: body.username,
          displayName: body.displayName,
          passwordHash,
          isAdmin: true,
        })
        if (ok)
          audit({ actorId: id, action: 'setup.admin_created', targetType: 'user', targetId: id })
        return ok
      })
      if (!created) return sendError(res, 404, 'not_found')

      setSessionCookies(
        res,
        createSession(repos.sessions, id, meta(req), ctx.now()),
        ctx.cookieSecure,
      )
      res.status(201).json({
        user: publicUser({
          id,
          username: body.username,
          displayName: body.displayName,
          isAdmin: true,
          totpEnabled: false,
        }),
        totpEnrollmentRequired: true,
      })
    }),
  )

  // ----- Login / logout -----

  const loginBody = z.object({
    username: z.string().trim().toLowerCase().min(1).max(64),
    password: passwordSchema.min(1),
    code: z.string().trim().max(32).optional(),
  })
  r.post(
    '/auth/login',
    validateBody(loginBody),
    h(async (req, res) => {
      const body = req.body as z.infer<typeof loginBody>
      const ipKey = `ip:${ip(req)}`
      const userKey = `user:${body.username}`
      const wait = Math.max(ctx.limiter.retryAfterMs(ipKey), ctx.limiter.retryAfterMs(userKey))
      if (wait > 0) {
        res.setHeader('Retry-After', Math.ceil(wait / 1000))
        return sendError(res, 429, 'too_many_attempts')
      }

      const fail = (userId?: string) => {
        const lockedIp = ctx.limiter.fail(ipKey)
        const lockedUser = ctx.limiter.fail(userKey)
        const detail = { username: body.username, ip: ip(req) }
        audit({ action: 'auth.login_failed', targetType: 'user', targetId: userId, meta: detail })
        if (lockedIp || lockedUser) {
          audit({ action: 'auth.lockout', targetType: 'user', targetId: userId, meta: detail })
        }
        return sendError(res, 401, 'invalid_credentials')
      }

      const user = repos.users.findByUsername(body.username)
      if (!user || user.status !== 'active') {
        await verifyAgainstDummy(body.password)
        return fail(user?.id)
      }
      if (!(await verifyPassword(user.passwordHash, body.password))) return fail(user.id)

      if (user.totpEnabledAt && user.totpSecretEnc) {
        if (!body.code) return sendError(res, 401, 'totp_required')
        let ok = false
        if (/^\d{6}$/.test(body.code)) {
          ok = verifyTotp(ctx.crypto.decrypt(user.totpSecretEnc), body.code)
        } else {
          const rc = repos.recoveryCodes.findUnused(user.id, hashRecoveryCode(body.code))
          if (rc) {
            repos.recoveryCodes.markUsed(rc.id, ctx.now().toISOString())
            audit({
              actorId: user.id,
              action: 'auth.recovery_code_used',
              targetType: 'user',
              targetId: user.id,
            })
            ok = true
          }
        }
        if (!ok) return fail(user.id)
      }

      ctx.limiter.success(userKey)
      repos.users.update(user.id, { lastLoginAt: ctx.now().toISOString() })
      audit({
        actorId: user.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        meta: { ip: ip(req) },
      })
      setSessionCookies(
        res,
        createSession(repos.sessions, user.id, meta(req), ctx.now()),
        ctx.cookieSecure,
      )
      const totpEnabled = user.totpEnabledAt !== null
      res.json({
        user: publicUser({ ...user, totpEnabled }),
        totpEnrollmentRequired: user.isAdmin && !totpEnabled,
      })
    }),
  )

  r.post('/auth/logout', requireAuth({ allowPendingTotp: true }), (req, res) => {
    revokeSession(repos.sessions, req.auth!.sessionId)
    clearSessionCookies(res, ctx.cookieSecure)
    res.json({ ok: true })
  })

  r.get('/auth/me', requireAuth({ allowPendingTotp: true }), (req, res) => {
    const u = req.auth!.user
    res.json({ user: publicUser(u), totpEnrollmentRequired: u.isAdmin && !u.totpEnabled })
  })

  // ----- TOTP enrollment -----

  r.post('/auth/totp/enroll', requireAuth({ allowPendingTotp: true }), (req, res) => {
    const u = req.auth!.user
    if (u.totpEnabled) return sendError(res, 409, 'totp_already_enabled')
    const secret = newTotpSecret()
    repos.users.update(u.id, { totpSecretEnc: ctx.crypto.encrypt(secret) })
    // The secret is shown once, for the authenticator app; it is stored encrypted.
    res.json({ secret, uri: totpUri(secret, u.username) })
  })

  const confirmBody = z.object({ code: z.string().regex(/^\d{6}$/) })
  r.post(
    '/auth/totp/confirm',
    requireAuth({ allowPendingTotp: true }),
    validateBody(confirmBody),
    (req, res) => {
      const u = req.auth!.user
      if (u.totpEnabled) return sendError(res, 409, 'totp_already_enabled')
      const enc = repos.users.findById(u.id)?.totpSecretEnc
      if (!enc) return sendError(res, 409, 'totp_not_started')
      if (!verifyTotp(ctx.crypto.decrypt(enc), (req.body as z.infer<typeof confirmBody>).code)) {
        return sendError(res, 400, 'invalid_code')
      }
      const codes = generateRecoveryCodes()
      repos.transaction(() => {
        repos.users.update(u.id, { totpEnabledAt: ctx.now().toISOString() })
        repos.recoveryCodes.replaceForUser(
          u.id,
          codes.map((c) => ({ id: ctx.newId(), codeHash: hashRecoveryCode(c) })),
        )
        audit({ actorId: u.id, action: 'auth.totp_enabled', targetType: 'user', targetId: u.id })
      })
      res.json({ recoveryCodes: codes })
    },
  )

  // ----- Password and re-authentication -----

  const passwordBody = z.object({
    currentPassword: passwordSchema.min(1),
    newPassword: passwordSchema,
  })
  r.post(
    '/auth/password',
    requireAuth(),
    validateBody(passwordBody),
    h(async (req, res) => {
      const u = req.auth!.user
      const body = req.body as z.infer<typeof passwordBody>
      const key = `reauth:${u.id}`
      if (ctx.limiter.retryAfterMs(key) > 0) return sendError(res, 429, 'too_many_attempts')
      const row = repos.users.findById(u.id)
      if (!row || !(await verifyPassword(row.passwordHash, body.currentPassword))) {
        ctx.limiter.fail(key)
        return sendError(res, 401, 'invalid_credentials')
      }
      ctx.limiter.success(key)
      const problem = checkPasswordStrength(body.newPassword, u.username)
      if (problem) return sendError(res, 400, 'weak_password', { reason: problem })
      repos.users.update(u.id, { passwordHash: await hashPassword(body.newPassword) })
      revokeUserSessions(repos.sessions, u.id, req.auth!.sessionId) // security.md: revoke on password change
      markReauth(repos.sessions, req.auth!.sessionId, ctx.now())
      audit({ actorId: u.id, action: 'auth.password_changed', targetType: 'user', targetId: u.id })
      res.json({ ok: true })
    }),
  )

  const reauthBody = z.object({ password: passwordSchema.min(1) })
  r.post(
    '/auth/reauth',
    requireAuth(),
    validateBody(reauthBody),
    h(async (req, res) => {
      const u = req.auth!.user
      const key = `reauth:${u.id}`
      if (ctx.limiter.retryAfterMs(key) > 0) return sendError(res, 429, 'too_many_attempts')
      const row = repos.users.findById(u.id)
      const pw = (req.body as z.infer<typeof reauthBody>).password
      if (!row || !(await verifyPassword(row.passwordHash, pw))) {
        ctx.limiter.fail(key)
        return sendError(res, 401, 'invalid_credentials')
      }
      ctx.limiter.success(key)
      markReauth(repos.sessions, req.auth!.sessionId, ctx.now())
      res.json({ ok: true })
    }),
  )

  return r
}
