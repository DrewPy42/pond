import { commitImportSchema, previewImportSchema } from '@pond/shared'
import type { Request } from 'express'
import type { AppContext } from '../context.js'
import { validateBody } from '../http.js'
import { commitImport, listImportBatches, previewImport } from '../imports/service.js'
import type { createSpaceRouter } from '../middleware/spaceRouter.js'
import { domainHandler as run } from './handler.js'

/** CSV import for a Space's accounts: preview first (saves nothing), then commit the reviewed rows. */
export function registerImportRoutes(
  ctx: AppContext,
  sp: ReturnType<typeof createSpaceRouter>,
): void {
  const deps = { repos: ctx.repos, newId: ctx.newId, now: ctx.now }
  const actor = (req: Request) => ({ id: req.auth!.user.id, isAdmin: req.auth!.user.isAdmin })
  const space = (req: Request) => req.space!.id

  sp.get(
    '/imports',
    'viewer',
    run((req, res) => {
      res.json({ imports: listImportBatches(deps, space(req)) })
    }),
  )

  sp.post(
    '/imports/preview',
    'editor',
    validateBody(previewImportSchema),
    run((req, res) => {
      res.json({ preview: previewImport(deps, space(req), req.body) })
    }),
  )

  sp.post(
    '/imports',
    'editor',
    validateBody(commitImportSchema),
    run((req, res) => {
      res.status(201).json({ result: commitImport(deps, actor(req), space(req), req.body) })
    }),
  )
}
