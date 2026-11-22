import { Router } from 'express'
import { z } from 'zod'
import { recordAudit } from '../audit.js'
import { checkPasswordStrength, hashPassword } from '../auth/password.js'
import { revokeUserSessions } from '../auth/sessions.js'
import type { AppContext } from '../context.js'
import { h, sendError, validateBody } from '../http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { DuplicateError, type UserRecord } from '../repos/types.js'
import { usernameSchema } from './auth.js'

const adminView = (u: UserRecord) => ({
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
  const { repos } = ctx
  const audit = (entry: Parameters<typeof recordAudit>[1]) =>
    recordAudit(repos.audit, entry, ctx.now(), ctx.newId)
  r.use(requireAuth(), requireAdmin)

  r.get('/', (_req, res) => {
    res.json({ users: repos.users.list().map(adminView) })
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
      const id = ctx.newId()
      try {
        repos.users.create({
          id,
          username: b.username,
          displayName: b.displayName,
          email: b.email ?? null,
          passwordHash: await hashPassword(b.password),
          isAdmin: b.isAdmin,
        })
      } catch (e) {
        if (e instanceof DuplicateError) return sendError(res, 409, 'username_taken')
        throw e
      }
      audit({
        actorId: req.auth!.user.id,
        action: 'user.created',
        targetType: 'user',
        targetId: id,
        meta: { isAdmin: b.isAdmin },
      })
      res.status(201).json({ user: adminView(repos.users.findById(id)!) })
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
    const target = repos.users.findById(id)
    if (!target) return sendError(res, 404, 'not_found')

    const losesAdmin =
      target.isAdmin &&
      target.status === 'active' &&
      (b.isAdmin === false || b.status === 'disabled')
    if (losesAdmin && repos.users.countActiveAdminsExcept(id) === 0) {
      return sendError(res, 409, 'last_admin')
    }
    repos.users.update(id, b)
    if (b.status === 'disabled') revokeUserSessions(repos.sessions, id) // security.md: revoke on disable
    const actor = req.auth!.user.id
    if (b.isAdmin !== undefined && b.isAdmin !== target.isAdmin) {
      audit({
        actorId: actor,
        action: 'user.role_changed',
        targetType: 'user',
        targetId: id,
        meta: { isAdmin: b.isAdmin },
      })
    }
    if (b.status !== undefined && b.status !== target.status) {
      audit({
        actorId: actor,
        action: b.status === 'disabled' ? 'user.disabled' : 'user.enabled',
        targetType: 'user',
        targetId: id,
      })
    }
    if (b.displayName !== undefined || b.email !== undefined) {
      audit({ actorId: actor, action: 'user.updated', targetType: 'user', targetId: id })
    }
    res.json({ user: adminView(repos.users.findById(id)!) })
  })

  return r
}
