import { Router, type Request } from 'express'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { sendError, validateBody } from '../http.js'
import { LedgerError } from '../ledger/service.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import type { createSpaceRouter } from '../middleware/spaceRouter.js'
import { SettingError } from '../lilypads/settings.js'
import { domainHandler } from './handler.js'

const asyncHandler =
  (
    fn: (req: Request, res: import('express').Response) => Promise<void> | void,
  ): import('express').RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res)
    } catch (e) {
      if (e instanceof LedgerError) return sendError(res, e.status, e.code, e.extra)
      if (e instanceof SettingError) return sendError(res, 400, e.code, { message: e.message })
      next(e)
    }
  }

/** Admin routes: see, install and remove LilyPads, and their global settings. */
export function padsAdminRouter(ctx: AppContext): Router {
  const r = Router()
  const host = ctx.padHost
  const actor = (req: Request) => ({ id: req.auth!.user.id, isAdmin: true })
  r.use(requireAuth(), requireAdmin)

  r.get('/', (_req, res) => {
    res.json({ pads: host.list() })
  })

  const installBody = z.object({ permissions: z.array(z.string().max(60)).max(20) })
  r.post(
    '/:padId/install',
    validateBody(installBody),
    asyncHandler(async (req, res) => {
      res.json({
        pad: await host.install(actor(req), String(req.params.padId), req.body.permissions),
      })
    }),
  )

  const uninstallBody = z.object({ deleteData: z.boolean() })
  r.post(
    '/:padId/uninstall',
    validateBody(uninstallBody),
    asyncHandler((req, res) => {
      host.uninstall(actor(req), String(req.params.padId), req.body.deleteData)
      res.json({ ok: true })
    }),
  )

  // Global (admin-only) settings of a pad.
  r.get(
    '/:padId/settings',
    asyncHandler((req, res) => {
      res.json(host.settingsFor(String(req.params.padId), '', 'global'))
    }),
  )
  r.put(
    '/:padId/settings',
    validateBody(
      z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }),
    ),
    asyncHandler((req, res) => {
      host.saveSettings(String(req.params.padId), '', 'global', req.body.values)
      res.json(host.settingsFor(String(req.params.padId), '', 'global'))
    }),
  )
  return r
}

/**
 * Space-scoped host routes, declared through the Space router like every other Space route, so the
 * permission suite covers them. (Pad-declared routes live under /lilypads/<id>/, these under /pads.)
 */
export function registerPadSpaceRoutes(
  ctx: AppContext,
  sp: ReturnType<typeof createSpaceRouter>,
): void {
  const host = ctx.padHost
  const actor = (req: Request) => ({ id: req.auth!.user.id, isAdmin: req.auth!.user.isAdmin })
  const space = (req: Request) => req.space!.id

  // What is running here: drives the sidebar, dashboard widgets and panels.
  sp.get(
    '/pads',
    'viewer',
    domainHandler((req, res) => {
      res.json({ pads: host.listForSpace(space(req)) })
    }),
  )

  // Installed pads this Space can switch on (owners decide).
  sp.get(
    '/pads/available',
    'owner',
    domainHandler((req, res) => {
      res.json({ pads: host.availableForSpace(space(req)) })
    }),
  )

  sp.put(
    '/pads/:padId/enabled',
    'owner',
    validateBody(z.object({ enabled: z.boolean() })),
    domainHandler((req, res) => {
      host.setEnabled(actor(req), space(req), String(req.params.padId), req.body.enabled)
      res.json({ ok: true })
    }),
  )

  sp.get(
    '/pads/:padId/settings',
    'viewer',
    asyncHandler((req, res) => {
      res.json(host.settingsFor(String(req.params.padId), space(req), 'space'))
    }),
  )

  sp.put(
    '/pads/:padId/settings',
    'owner',
    validateBody(
      z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }),
    ),
    asyncHandler((req, res) => {
      host.saveSettings(String(req.params.padId), space(req), 'space', req.body.values)
      res.json(host.settingsFor(String(req.params.padId), space(req), 'space'))
    }),
  )
}
