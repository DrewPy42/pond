import { Router } from 'express'
import { desc, lt } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { auditLog } from '../db/schema.js'
import { sendError } from '../http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().max(40).optional(),
})

export function auditRouter(ctx: AppContext): Router {
  const r = Router()
  r.get('/', requireAuth(), requireAdmin, (req, res) => {
    const q = query.safeParse(req.query)
    if (!q.success) return sendError(res, 400, 'invalid_input')
    const rows = ctx.db.db
      .select()
      .from(auditLog)
      .where(q.data.before ? lt(auditLog.at, q.data.before) : undefined)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(q.data.limit)
      .all()
    res.json({
      entries: rows.map((e) => ({
        id: e.id,
        at: e.at,
        actorType: e.actorType,
        actorId: e.actorId,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        spaceId: e.spaceId,
        meta: e.meta,
      })),
    })
  })
  return r
}
