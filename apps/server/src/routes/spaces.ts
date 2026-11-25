import { Router, type Request } from 'express'
import { z } from 'zod'
import { recordAudit } from '../audit.js'
import type { AppContext } from '../context.js'
import { sendError, validateBody } from '../http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { seedCategories } from '../ledger/service.js'
import { createSpaceRouter } from '../middleware/spaceRouter.js'
import { usernameSchema } from './auth.js'
import { registerImportRoutes } from './imports.js'
import { registerPadSpaceRoutes } from './pads.js'
import { registerLedgerRoutes } from './ledger.js'
import { registerRuleRoutes } from './rules.js'
import { MissingParentError, type SpaceRecord } from '../repos/types.js'

const spaceView = (s: SpaceRecord, role: string) => ({
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
  const { repos } = ctx
  const root = Router()
  const audit = (entry: Parameters<typeof recordAudit>[1]) =>
    recordAudit(repos.audit, entry, ctx.now(), ctx.newId)

  // Only spaces the caller can see: their memberships, or everything for an admin. Archived
  // ones are left out; the administrator lists those separately.
  root.get('/', requireAuth(), (req, res) => {
    const u = req.auth!.user
    if (u.isAdmin) {
      res.json({
        spaces: repos.spaces
          .listAll()
          .filter((s) => s.archivedAt === null)
          .map((s) => spaceView(s, 'owner')),
      })
      return
    }
    res.json({
      spaces: repos.spaces
        .listForUser(u.id)
        .filter((x) => x.space.archivedAt === null)
        .map((x) => spaceView(x.space, x.role)),
    })
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
    if (b.ownerUserId && !repos.users.findById(b.ownerUserId)) {
      return sendError(res, 400, 'unknown_user')
    }
    const id = ctx.newId()
    repos.transaction(() => {
      repos.spaces.create({ id, name: b.name, type: b.type, currency: b.currency })
      seedCategories({ repos, newId: ctx.newId, now: ctx.now }, id, b.type)
      if (b.ownerUserId) repos.spaces.setMember(id, b.ownerUserId, 'owner')
    })
    audit({
      actorId: req.auth!.user.id,
      action: 'space.created',
      targetType: 'space',
      targetId: id,
      spaceId: id,
      meta: { type: b.type },
    })
    ctx.events.emit({ type: 'space.created', spaceId: id })
    res.status(201).json({ space: spaceView(repos.spaces.findById(id)!, 'owner') })
  })

  // ----- Archive, restore and delete: administrator only -----
  // Not Space-scoped on purpose: an archived Space answers 404 to every Space route.

  const known = (req: Request) => repos.spaces.findById(String(req.params.spaceId))
  const record = (req: Request, action: string, spaceId: string) =>
    audit({
      actorId: req.auth!.user.id,
      action,
      targetType: 'space',
      targetId: spaceId,
      spaceId,
    })

  root.get('/archived', requireAuth(), requireAdmin, (_req, res) => {
    res.json({
      spaces: repos.spaces
        .listAll()
        .filter((s) => s.archivedAt !== null)
        .map((s) => spaceView(s, 'owner')),
    })
  })

  root.post('/:spaceId/archive', requireAuth(), requireAdmin, (req, res) => {
    const s = known(req)
    if (!s) return sendError(res, 404, 'not_found')
    if (s.archivedAt === null) {
      repos.spaces.update(s.id, { archivedAt: ctx.now().toISOString() })
      record(req, 'space.archived', s.id)
    }
    res.json({ ok: true })
  })

  root.post('/:spaceId/restore', requireAuth(), requireAdmin, (req, res) => {
    const s = known(req)
    if (!s) return sendError(res, 404, 'not_found')
    if (s.archivedAt !== null) {
      repos.transaction(() => {
        repos.spaces.update(s.id, { archivedAt: null })
        // Bank accounts here weren't synced while it was away, so their connections look back
        // as far as a first sync does. Anything already stored is recognised, not repeated.
        for (const a of repos.accounts.listForSpace(s.id, { includeArchived: true }))
          if (a.connectionId) repos.connections.update(a.connectionId, { lastSyncedAt: null })
      })
      record(req, 'space.restored', s.id)
    }
    res.json({ ok: true })
  })

  // Permanent, so only for a Space that never held anything.
  root.delete('/:spaceId', requireAuth(), requireAdmin, (req, res) => {
    const s = known(req)
    if (!s) return sendError(res, 404, 'not_found')
    const contents = repos.spaces.contents(s.id)
    if (contents.accounts || contents.splits || contents.appRows) {
      return sendError(res, 409, 'space_not_empty', { contents })
    }
    repos.transaction(() => {
      repos.spaces.delete(s.id)
      record(req, 'space.deleted', s.id)
    })
    res.json({ ok: true })
  })

  // ----- Space-scoped: every route is declared through the shared Space router -----
  const sp = createSpaceRouter(repos, '/api/spaces/:spaceId', ctx.spaceRoutes)

  sp.get('/', 'viewer', (req, res) => {
    res.json({ space: spaceView(repos.spaces.findById(req.space!.id)!, req.space!.role) })
  })

  // Owners rename. Archiving is the administrator's, above.
  const patchBody = z.object({ name: z.string().trim().min(1).max(80) })
  sp.patch('/', 'owner', validateBody(patchBody), (req, res) => {
    repos.spaces.update(req.space!.id, { name: (req.body as z.infer<typeof patchBody>).name })
    audit({
      actorId: req.auth!.user.id,
      action: 'space.updated',
      targetType: 'space',
      targetId: req.space!.id,
      spaceId: req.space!.id,
    })
    res.json({ space: spaceView(repos.spaces.findById(req.space!.id)!, req.space!.role) })
  })

  sp.get('/members', 'viewer', (req, res) => {
    res.json({ members: repos.spaces.listMembers(req.space!.id) })
  })

  const memberBody = z.object({ role: roleSchema })
  sp.put('/members/:userId', 'owner', validateBody(memberBody), (req, res) => {
    const userId = String(req.params.userId)
    const role = (req.body as z.infer<typeof memberBody>).role
    const spaceId = req.space!.id
    // A Space must keep an owner: the last one can't be turned into an editor or viewer.
    if (
      role !== 'owner' &&
      repos.spaces.getRole(spaceId, userId) === 'owner' &&
      repos.spaces.countOwners(spaceId) <= 1
    ) {
      return sendError(res, 409, 'last_owner')
    }
    let outcome: 'added' | 'changed'
    try {
      outcome = repos.spaces.setMember(spaceId, userId, role)
    } catch (e) {
      if (e instanceof MissingParentError) return sendError(res, 400, 'unknown_user')
      throw e
    }
    audit({
      actorId: req.auth!.user.id,
      action: outcome === 'added' ? 'space.member_added' : 'space.member_role_changed',
      targetType: 'user',
      targetId: userId,
      spaceId,
      meta: { role },
    })
    res.json({ member: { userId, role } })
  })

  // Adding someone by username, for owners who aren't the administrator: only the administrator
  // can list users, so an owner has to know exactly who they mean.
  const addBody = z.object({ username: usernameSchema, role: roleSchema })
  sp.post('/members', 'owner', validateBody(addBody), (req, res) => {
    const b = req.body as z.infer<typeof addBody>
    const spaceId = req.space!.id
    const user = repos.users.findByUsername(b.username)
    if (!user || user.status !== 'active') return sendError(res, 400, 'unknown_user')
    // Never changes an existing role by accident; that is what PUT is for.
    if (repos.spaces.getRole(spaceId, user.id)) return sendError(res, 409, 'already_member')
    repos.spaces.setMember(spaceId, user.id, b.role)
    audit({
      actorId: req.auth!.user.id,
      action: 'space.member_added',
      targetType: 'user',
      targetId: user.id,
      spaceId,
      meta: { role: b.role },
    })
    res.status(201).json({ member: { userId: user.id, role: b.role } })
  })

  sp.delete('/members/:userId', 'owner', (req, res) => {
    const userId = String(req.params.userId)
    const spaceId = req.space!.id
    const current = repos.spaces.getRole(spaceId, userId)
    if (!current) return sendError(res, 404, 'not_found')
    if (current === 'owner' && repos.spaces.countOwners(spaceId) <= 1) {
      return sendError(res, 409, 'last_owner')
    }
    repos.spaces.removeMember(spaceId, userId)
    audit({
      actorId: req.auth!.user.id,
      action: 'space.member_removed',
      targetType: 'user',
      targetId: userId,
      spaceId,
    })
    res.json({ ok: true })
  })

  registerLedgerRoutes(ctx, sp)
  registerRuleRoutes(ctx, sp)
  registerImportRoutes(ctx, sp)
  registerPadSpaceRoutes(ctx, sp)
  ctx.padHost.attachRouter(sp)

  root.use('/:spaceId', sp.router)
  return root
}
