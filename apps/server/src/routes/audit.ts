import { Router } from 'express'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { sendError } from '../http.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** The time and id of the last entry already shown, to carry on after it. */
  before: z.string().max(40).optional(),
  beforeId: z.string().max(64).optional(),
})

export function auditRouter(ctx: AppContext): Router {
  const r = Router()
  r.get('/', requireAuth(), requireAdmin, (req, res) => {
    const q = query.safeParse(req.query)
    if (!q.success) return sendError(res, 400, 'invalid_input')
    res.json({ entries: ctx.repos.audit.list(q.data) })
  })
  return r
}
