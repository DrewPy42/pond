import { Router } from 'express'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { recordAudit } from '../audit.js'
import type { AppContext } from '../context.js'
import { newId } from '../db/ids.js'
import { spaceMembers, spaces, users } from '../db/schema.js'
import { h, sendError, validateBody } from '../http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { createSpaceRouter } from '../middleware/spaceRouter.js'

const spaceView = (s: typeof spaces.$inferSelect, role: string) => ({
  id: s.id,
  name: s.name,
  type: s.type,
  currency: s.currency,
  archivedAt: s.archivedAt,
  role,
})

const roleSchema = z.enum(['owner', 'editor', 'viewer'])

/** Space list/create (not Space-scoped) and the Space-scoped routes under /api/spaces/:spaceId. */
export function spacesRouter(ctx: AppContext): Router {
  const db = ctx.db.db
  const root = Router()

  // Only spaces the caller can see: their memberships, or everything for an admin.
  root.get('/', requireAuth(), (req, res) => {
    const u = req.auth!.user
    if (u.isAdmin) {
      res.json({
        spaces: db
          .select()
          .from(spaces)
          .orderBy(asc(spaces.name))
          .all()
          .map((s) => spaceView(s, 'owner')),
      })
      return
    }
    const rows = db
      .select({ s: spaces, role: spaceMembers.role })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(eq(spaceMembers.userId, u.id))
      .orderBy(asc(spaces.name))
      .all()
    res.json({ spaces: rows.map((r) => spaceView(r.s, r.role)) })
  })

  const createBody = z.object({
    name: z.string().trim().min(1).max(80),
    type: z.enum(['personal', 'business']),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .default('USD'),
    ownerUserId: z.string().min(1).optional(),
  })
  root.post('/', requireAuth(), requireAdmin, validateBody(createBody), (req, res) => {
    const b = req.body as z.infer<typeof createBody>
    if (
      b.ownerUserId &&
      !db.select({ id: users.id }).from(users).where(eq(users.id, b.ownerUserId)).get()
    ) {
      return sendError(res, 400, 'unknown_user')
    }
    const id = newId()
    db.insert(spaces).values({ id, name: b.name, type: b.type, currency: b.currency }).run()
    if (b.ownerUserId)
      db.insert(spaceMembers).values({ spaceId: id, userId: b.ownerUserId, role: 'owner' }).run()
    recordAudit(
      db,
      {
        actorId: req.auth!.user.id,
        action: 'space.created',
        targetType: 'space',
        targetId: id,
        spaceId: id,
        meta: { type: b.type },
      },
      ctx.now(),
    )
    res
      .status(201)
      .json({ space: spaceView(db.select().from(spaces).where(eq(spaces.id, id)).get()!, 'owner') })
  })

  // ----- Space-scoped: every route is declared through the shared Space router -----
  const sp = createSpaceRouter(ctx.db.db, '/api/spaces/:spaceId', ctx.spaceRoutes)

  sp.get('/', 'viewer', (req, res) => {
    const s = db.select().from(spaces).where(eq(spaces.id, req.space!.id)).get()!
    res.json({ space: spaceView(s, req.space!.role) })
  })

  const patchBody = z
    .object({ name: z.string().trim().min(1).max(80), archived: z.boolean() })
    .partial()
    .refine((v) => Object.keys(v).length > 0, 'nothing to update')
  sp.patch('/', 'owner', validateBody(patchBody), (req, res) => {
    const b = req.body as z.infer<typeof patchBody>
    const set: Partial<typeof spaces.$inferInsert> = { updatedAt: ctx.now().toISOString() }
    if (b.name !== undefined) set.name = b.name
    if (b.archived !== undefined) set.archivedAt = b.archived ? ctx.now().toISOString() : null
    db.update(spaces).set(set).where(eq(spaces.id, req.space!.id)).run()
    recordAudit(
      db,
      {
        actorId: req.auth!.user.id,
        action: 'space.updated',
        targetType: 'space',
        targetId: req.space!.id,
        spaceId: req.space!.id,
      },
      ctx.now(),
    )
    const s = db.select().from(spaces).where(eq(spaces.id, req.space!.id)).get()!
    res.json({ space: spaceView(s, req.space!.role) })
  })

  sp.get('/members', 'viewer', (req, res) => {
    const rows = db
      .select({
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        role: spaceMembers.role,
      })
      .from(spaceMembers)
      .innerJoin(users, eq(users.id, spaceMembers.userId))
      .where(eq(spaceMembers.spaceId, req.space!.id))
      .orderBy(asc(users.username))
      .all()
    res.json({ members: rows })
  })

  const memberBody = z.object({ role: roleSchema })
  sp.put('/members/:userId', 'owner', validateBody(memberBody), (req, res) => {
    const userId = String(req.params.userId)
    const role = (req.body as z.infer<typeof memberBody>).role
    const spaceId = req.space!.id
    if (!db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get()) {
      return sendError(res, 400, 'unknown_user')
    }
    const existing = db
      .select()
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
      .get()
    if (existing) {
      db.update(spaceMembers)
        .set({ role, updatedAt: ctx.now().toISOString() })
        .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
        .run()
    } else {
      db.insert(spaceMembers).values({ spaceId, userId, role }).run()
    }
    recordAudit(
      db,
      {
        actorId: req.auth!.user.id,
        action: existing ? 'space.member_role_changed' : 'space.member_added',
        targetType: 'user',
        targetId: userId,
        spaceId,
        meta: { role },
      },
      ctx.now(),
    )
    res.json({ member: { userId, role } })
  })

  sp.delete(
    '/members/:userId',
    'owner',
    h((req, res) => {
      const userId = String(req.params.userId)
      const spaceId = req.space!.id
      const target = db
        .select()
        .from(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
        .get()
      if (!target) return sendError(res, 404, 'not_found')
      if (target.role === 'owner') {
        const owners = db
          .select({ u: spaceMembers.userId })
          .from(spaceMembers)
          .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.role, 'owner')))
          .all()
        if (owners.length <= 1) return sendError(res, 409, 'last_owner')
      }
      db.delete(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
        .run()
      recordAudit(
        db,
        {
          actorId: req.auth!.user.id,
          action: 'space.member_removed',
          targetType: 'user',
          targetId: userId,
          spaceId,
        },
        ctx.now(),
      )
      res.json({ ok: true })
    }),
  )

  root.use('/:spaceId', sp.router)
  return root
}
