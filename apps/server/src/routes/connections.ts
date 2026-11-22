import { Router, type Request, type RequestHandler, type Response } from 'express'
import { accountTypes } from '@pond/shared'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { sendError, validateBody } from '../http.js'
import { LedgerError } from '../ledger/service.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import {
  assignAccount,
  connectSimpleFin,
  connectionView,
  discoverAccounts,
  listConnections,
  revokeConnection,
  syncConnection,
  toLedgerError,
  type SyncDeps,
} from '../sync/service.js'
import { SimpleFinError } from '../simplefin/types.js'

/**
 * SimpleFIN connections. Admin-only: a connection is the household's bank link, and its
 * accounts may belong to any Space. The Access URL never appears in any response.
 */
export function connectionsRouter(ctx: AppContext): Router {
  const r = Router()
  r.use(requireAuth(), requireAdmin)
  const deps: SyncDeps = {
    repos: ctx.repos,
    newId: ctx.newId,
    now: ctx.now,
    crypto: ctx.crypto,
    client: ctx.simplefin,
    timeZone: ctx.timeZone,
  }
  const actor = (req: Request) => ({ id: req.auth!.user.id, isAdmin: true })

  const run =
    (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res)
      } catch (e) {
        const err = e instanceof SimpleFinError ? toLedgerError(e) : e
        if (err instanceof LedgerError) return sendError(res, err.status, err.code, err.extra)
        next(err)
      }
    }

  r.get('/', (_req, res) => {
    res.json({ connections: listConnections(deps) })
  })

  const connectBody = z.object({
    setupToken: z.string().trim().min(8).max(4096),
    label: z.string().trim().min(1).max(80),
  })
  r.post(
    '/',
    validateBody(connectBody),
    run(async (req, res) => {
      res.status(201).json(await connectSimpleFin(deps, actor(req), req.body))
    }),
  )

  r.post(
    '/:connectionId/discover',
    run(async (req, res) => {
      const id = String(req.params.connectionId)
      const discovery = await discoverAccounts(deps, id)
      res.json({ discovery, connection: connectionView(deps, ctx.repos.connections.findById(id)!) })
    }),
  )

  r.post(
    '/:connectionId/sync',
    run(async (req, res) => {
      const id = String(req.params.connectionId)
      const summary = await syncConnection(deps, id, { manual: true })
      res.json({ summary, connection: connectionView(deps, ctx.repos.connections.findById(id)!) })
    }),
  )

  const assignBody = z.object({
    primarySpaceId: z.string().min(1).nullable(),
    name: z.string().trim().min(1).max(80).optional(),
    type: z.enum(accountTypes).optional(),
  })
  r.patch(
    '/:connectionId/accounts/:accountId',
    validateBody(assignBody),
    run((req, res) => {
      res.json({
        account: assignAccount(
          deps,
          actor(req),
          String(req.params.connectionId),
          String(req.params.accountId),
          req.body,
        ),
      })
    }),
  )

  r.delete(
    '/:connectionId',
    run((req, res) => {
      revokeConnection(deps, actor(req), String(req.params.connectionId))
      res.json({ ok: true })
    }),
  )

  return r
}
