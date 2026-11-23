import { createRuleSchema, previewRuleSchema, updateRuleSchema } from '@pond/shared'
import type { Request } from 'express'
import type { AppContext } from '../context.js'
import { validateBody } from '../http.js'
import type { createSpaceRouter } from '../middleware/spaceRouter.js'
import {
  createRule,
  deleteRule,
  listRules,
  previewRule,
  runRulesOnExisting,
  updateRule,
} from '../rules/service.js'
import { domainHandler as run } from './handler.js'

/** Rules for a Space. Declared through the Space router, so the permission suite covers them. */
export function registerRuleRoutes(
  ctx: AppContext,
  sp: ReturnType<typeof createSpaceRouter>,
): void {
  const deps = { repos: ctx.repos, newId: ctx.newId, now: ctx.now }
  const actor = (req: Request) => ({ id: req.auth!.user.id, isAdmin: req.auth!.user.isAdmin })
  const space = (req: Request) => req.space!.id

  sp.get(
    '/rules',
    'viewer',
    run((req, res) => {
      res.json({ rules: listRules(deps, space(req)) })
    }),
  )

  sp.post(
    '/rules',
    'editor',
    validateBody(createRuleSchema),
    run((req, res) => {
      res.status(201).json({ rule: createRule(deps, actor(req), space(req), req.body) })
    }),
  )

  sp.post(
    '/rules/preview',
    'editor',
    validateBody(previewRuleSchema),
    run((req, res) => {
      res.json(previewRule(deps, space(req), req.body.conditions))
    }),
  )

  sp.post(
    '/rules/run',
    'editor',
    run((req, res) => {
      res.json({ summary: runRulesOnExisting(deps, space(req)) })
    }),
  )

  sp.patch(
    '/rules/:ruleId',
    'editor',
    validateBody(updateRuleSchema),
    run((req, res) => {
      res.json({
        rule: updateRule(deps, actor(req), space(req), String(req.params.ruleId), req.body),
      })
    }),
  )

  sp.delete(
    '/rules/:ruleId',
    'editor',
    run((req, res) => {
      deleteRule(deps, space(req), String(req.params.ruleId))
      res.json({ ok: true })
    }),
  )
}
