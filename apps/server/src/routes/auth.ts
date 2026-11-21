import { Router } from 'express'
import { and, eq, isNull, sql } from 'drizzle-orm'
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
import { newId } from '../db/ids.js'
import { recoveryCodes, users } from '../db/schema.js'
import { h, sendError, validateBody } from '../http.js'
import { requireAuth } from '../middleware/auth.js'

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
  const { db } = ctx
  const ip = (req: { ip?: string }) => req.ip ?? 'unknown'
  const meta = (req: { ip?: string; headers: { 'user-agent'?: string } }) => ({
    ip: ip(req),
    userAgent: req.headers['user-agent'],
  })

  // ----- First run -----

  r.get('/setup/status', (_req, res) => {
    res.json({ setupRequired: ctx.setupCode.active })
  })

  const setupBody = z.object({
    setupCode: z.string().min(1).max(64),
    username: usernameSchema,
    displayName: displayNameSchema,
    password: passwordSchema,
  })
  r.post(
    '/setup',
    validateBody(setupBody),
    h(async (req, res) => {
      const body = req.body as z.infer<typeof setupBody>
      const key = `setup:${ip(req)}`
      const wait = ctx.limiter.retryAfterMs(key)
      if (wait > 0) {
        res.setHeader('Retry-After', Math.ceil(wait / 1000))
        return sendError(res, 429, 'too_many_attempts')
      }
      if (!ctx.setupCode.active) return sendError(res, 404, 'not_found')
      if (!ctx.setupCode.verify(body.setupCode)) {
        if (ctx.limiter.fail(key))
          recordAudit(db.db, { action: 'auth.lockout', meta: { scope: 'setup' } })
        return sendError(res, 403, 'invalid_setup_code')
      }
      const problem = checkPasswordStrength(body.password, body.username)
      if (problem) return sendError(res, 400, 'weak_password', { reason: problem })

      const passwordHash = await hashPassword(body.password)
      const id = newId()
      const created = db.sqlite.transaction(() => {
        // Re-check inside the transaction so two racing requests can't both create an admin.
        const existing = db.db
          .select({ n: sql<number>`count(*)` })
          .from(users)
          .get()
        if (!existing || existing.n > 0) return false
        db.db
          .insert(users)
          .values({
            id,
            username: body.username,
            displayName: body.displayName,
            passwordHash,
            isAdmin: true,
          })
          .run()
        recordAudit(
          db.db,
          { actorId: id, action: 'setup.admin_created', targetType: 'user', targetId: id },
          ctx.now(),
        )
        return true
      })()
      if (!created) return sendError(res, 404, 'not_found')
      ctx.setupCode.consume()

      setSessionCookies(res, createSession(db.db, id, meta(req), ctx.now()), ctx.cookieSecure)
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
        recordAudit(
          db.db,
          {
            action: 'auth.login_failed',
            targetType: 'user',
            targetId: userId,
            meta: { username: body.username, ip: ip(req) },
          },
          ctx.now(),
        )
        if (lockedIp || lockedUser) {
          recordAudit(
            db.db,
            {
              action: 'auth.lockout',
              targetType: 'user',
              targetId: userId,
              meta: { username: body.username, ip: ip(req) },
            },
            ctx.now(),
          )
        }
        return sendError(res, 401, 'invalid_credentials')
      }

      const user = db.db.select().from(users).where(eq(users.username, body.username)).get()
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
          const hash = hashRecoveryCode(body.code)
          const rc = db.db
            .select()
            .from(recoveryCodes)
            .where(
              and(
                eq(recoveryCodes.userId, user.id),
                eq(recoveryCodes.codeHash, hash),
                isNull(recoveryCodes.usedAt),
              ),
            )
            .get()
          if (rc) {
            db.db
              .update(recoveryCodes)
              .set({ usedAt: ctx.now().toISOString() })
              .where(eq(recoveryCodes.id, rc.id))
              .run()
            recordAudit(
              db.db,
              {
                actorId: user.id,
                action: 'auth.recovery_code_used',
                targetType: 'user',
                targetId: user.id,
              },
              ctx.now(),
            )
            ok = true
          }
        }
        if (!ok) return fail(user.id)
      }

      ctx.limiter.success(userKey)
      db.db
        .update(users)
        .set({ lastLoginAt: ctx.now().toISOString() })
        .where(eq(users.id, user.id))
        .run()
      recordAudit(
        db.db,
        {
          actorId: user.id,
          action: 'auth.login',
          targetType: 'user',
          targetId: user.id,
          meta: { ip: ip(req) },
        },
        ctx.now(),
      )
      setSessionCookies(res, createSession(db.db, user.id, meta(req), ctx.now()), ctx.cookieSecure)
      const totpEnabled = user.totpEnabledAt !== null
      res.json({
        user: publicUser({ ...user, totpEnabled }),
        totpEnrollmentRequired: user.isAdmin && !totpEnabled,
      })
    }),
  )

  r.post('/auth/logout', requireAuth({ allowPendingTotp: true }), (req, res) => {
    revokeSession(db.db, req.auth!.sessionId)
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
    db.db
      .update(users)
      .set({ totpSecretEnc: ctx.crypto.encrypt(secret), updatedAt: ctx.now().toISOString() })
      .where(eq(users.id, u.id))
      .run()
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
      const row = db.db
        .select({ enc: users.totpSecretEnc })
        .from(users)
        .where(eq(users.id, u.id))
        .get()
      if (!row?.enc) return sendError(res, 409, 'totp_not_started')
      if (
        !verifyTotp(ctx.crypto.decrypt(row.enc), (req.body as z.infer<typeof confirmBody>).code)
      ) {
        return sendError(res, 400, 'invalid_code')
      }
      const codes = generateRecoveryCodes()
      db.sqlite.transaction(() => {
        db.db
          .update(users)
          .set({ totpEnabledAt: ctx.now().toISOString(), updatedAt: ctx.now().toISOString() })
          .where(eq(users.id, u.id))
          .run()
        db.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, u.id)).run()
        for (const c of codes) {
          db.db
            .insert(recoveryCodes)
            .values({ id: newId(), userId: u.id, codeHash: hashRecoveryCode(c) })
            .run()
        }
        recordAudit(
          db.db,
          { actorId: u.id, action: 'auth.totp_enabled', targetType: 'user', targetId: u.id },
          ctx.now(),
        )
      })()
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
      const row = db.db
        .select({ hash: users.passwordHash })
        .from(users)
        .where(eq(users.id, u.id))
        .get()
      if (!row || !(await verifyPassword(row.hash, body.currentPassword))) {
        ctx.limiter.fail(key)
        return sendError(res, 401, 'invalid_credentials')
      }
      ctx.limiter.success(key)
      const problem = checkPasswordStrength(body.newPassword, u.username)
      if (problem) return sendError(res, 400, 'weak_password', { reason: problem })
      db.db
        .update(users)
        .set({
          passwordHash: await hashPassword(body.newPassword),
          updatedAt: ctx.now().toISOString(),
        })
        .where(eq(users.id, u.id))
        .run()
      revokeUserSessions(db.db, u.id, req.auth!.sessionId) // security.md: revoke on password change
      markReauth(db.db, req.auth!.sessionId, ctx.now())
      recordAudit(
        db.db,
        { actorId: u.id, action: 'auth.password_changed', targetType: 'user', targetId: u.id },
        ctx.now(),
      )
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
      const row = db.db
        .select({ hash: users.passwordHash })
        .from(users)
        .where(eq(users.id, u.id))
        .get()
      if (
        !row ||
        !(await verifyPassword(row.hash, (req.body as z.infer<typeof reauthBody>).password))
      ) {
        ctx.limiter.fail(key)
        return sendError(res, 401, 'invalid_credentials')
      }
      ctx.limiter.success(key)
      markReauth(db.db, req.auth!.sessionId, ctx.now())
      res.json({ ok: true })
    }),
  )

  return r
}
