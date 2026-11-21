import { Router } from 'express'
import { and, asc, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { recordAudit } from '../audit.js'
import { checkPasswordStrength, hashPassword } from '../auth/password.js'
import { revokeUserSessions } from '../auth/sessions.js'
import type { AppContext } from '../context.js'
import { newId } from '../db/ids.js'
import { users } from '../db/schema.js'
import { h, sendError, validateBody } from '../http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { usernameSchema } from './auth.js'

const adminView = (u: typeof users.$inferSelect) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  email: u.email,
  isAdmin: u.isAdmin,
  status: u.status,
  totpEnabled: u.totpEnabledAt !== null,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
})

/** Admin-only user management. Everyone else sees users only through Space membership. */
export function usersRouter(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db.db
  r.use(requireAuth(), requireAdmin)

  r.get('/', (_req, res) => {
    res.json({ users: db.select().from(users).orderBy(asc(users.username)).all().map(adminView) })
  })

  const createBody = z.object({
    username: usernameSchema,
    displayName: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(254).optional(),
    password: z.string().max(256),
    isAdmin: z.boolean().default(false),
  })
  r.post(
    '/',
    validateBody(createBody),
    h(async (req, res) => {
      const b = req.body as z.infer<typeof createBody>
      const problem = checkPasswordStrength(b.password, b.username)
      if (problem) return sendError(res, 400, 'weak_password', { reason: problem })
      if (db.select({ id: users.id }).from(users).where(eq(users.username, b.username)).get()) {
        return sendError(res, 409, 'username_taken')
      }
      const id = newId()
      db.insert(users)
        .values({
          id,
          username: b.username,
          displayName: b.displayName,
          email: b.email ?? null,
          passwordHash: await hashPassword(b.password),
          isAdmin: b.isAdmin,
        })
        .run()
      recordAudit(
        db,
        {
          actorId: req.auth!.user.id,
          action: 'user.created',
          targetType: 'user',
          targetId: id,
          meta: { isAdmin: b.isAdmin },
        },
        ctx.now(),
      )
      res
        .status(201)
        .json({ user: adminView(db.select().from(users).where(eq(users.id, id)).get()!) })
    }),
  )

  const patchBody = z
    .object({
      displayName: z.string().trim().min(1).max(80),
      email: z.string().trim().email().max(254).nullable(),
      isAdmin: z.boolean(),
      status: z.enum(['active', 'disabled']),
    })
    .partial()
    .refine((v) => Object.keys(v).length > 0, 'nothing to update')
  r.patch('/:userId', validateBody(patchBody), (req, res) => {
    const id = String(req.params.userId)
    const b = req.body as z.infer<typeof patchBody>
    const target = db.select().from(users).where(eq(users.id, id)).get()
    if (!target) return sendError(res, 404, 'not_found')

    const losesAdmin =
      target.isAdmin &&
      target.status === 'active' &&
      (b.isAdmin === false || b.status === 'disabled')
    if (losesAdmin) {
      const others = db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.isAdmin, true), eq(users.status, 'active'), ne(users.id, id)))
        .all()
      if (others.length === 0) return sendError(res, 409, 'last_admin')
    }
    db.update(users)
      .set({ ...b, updatedAt: ctx.now().toISOString() })
      .where(eq(users.id, id))
      .run()
    if (b.status === 'disabled') revokeUserSessions(db, id) // security.md: revoke on disable
    const actor = req.auth!.user.id
    if (b.isAdmin !== undefined && b.isAdmin !== target.isAdmin) {
      recordAudit(
        db,
        {
          actorId: actor,
          action: 'user.role_changed',
          targetType: 'user',
          targetId: id,
          meta: { isAdmin: b.isAdmin },
        },
        ctx.now(),
      )
    }
    if (b.status !== undefined && b.status !== target.status) {
      recordAudit(
        db,
        {
          actorId: actor,
          action: b.status === 'disabled' ? 'user.disabled' : 'user.enabled',
          targetType: 'user',
          targetId: id,
        },
        ctx.now(),
      )
    }
    if (b.displayName !== undefined || b.email !== undefined) {
      recordAudit(
        db,
        { actorId: actor, action: 'user.updated', targetType: 'user', targetId: id },
        ctx.now(),
      )
    }
    res.json({ user: adminView(db.select().from(users).where(eq(users.id, id)).get()!) })
  })

  return r
}
