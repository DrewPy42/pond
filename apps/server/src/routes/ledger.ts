import type { Request } from 'express'
import {
  createAccountSchema,
  createCategorySchema,
  createTransactionSchema,
  isoDateSchema,
  linkTransferSchema,
  setBalanceSchema,
  transactionQuerySchema,
  updateAccountSchema,
  updateCategorySchema,
  updateTransactionSchema,
} from '@pond/shared'
import type { AppContext } from '../context.js'
import { sendError, validateBody } from '../http.js'
import * as ledger from '../ledger/service.js'
import type { createSpaceRouter } from '../middleware/spaceRouter.js'
import { domainHandler } from './handler.js'

/**
 * Ledger routes, all Space-scoped: they are declared through the shared Space router, so each
 * one gets requireAuth + requireSpace and is covered by the permission suite automatically.
 * Handlers only validate, call `ledger/service`, and shape the response.
 */
export function registerLedgerRoutes(
  ctx: AppContext,
  sp: ReturnType<typeof createSpaceRouter>,
): void {
  const deps = { repos: ctx.repos, newId: ctx.newId, now: ctx.now, events: ctx.events }
  const actor = (req: Request) => ({ id: req.auth!.user.id, isAdmin: req.auth!.user.isAdmin })
  const space = (req: Request) => req.space!.id
  const param = (req: Request, name: string) => String(req.params[name])

  const run = domainHandler

  // ----- Accounts and balances -----

  sp.get(
    '/accounts',
    'viewer',
    run((req, res) => {
      res.json({
        accounts: ledger.listAccounts(deps, space(req), req.query.includeArchived === 'true'),
      })
    }),
  )

  sp.post(
    '/accounts',
    'editor',
    validateBody(createAccountSchema),
    run((req, res) => {
      res.status(201).json({ account: ledger.createAccount(deps, space(req), req.body) })
    }),
  )

  sp.get(
    '/accounts/:accountId',
    'viewer',
    run((req, res) => {
      res.json({ account: ledger.getAccount(deps, space(req), param(req, 'accountId')) })
    }),
  )

  sp.patch(
    '/accounts/:accountId',
    'editor',
    validateBody(updateAccountSchema),
    run((req, res) => {
      res.json({
        account: ledger.updateAccount(deps, space(req), param(req, 'accountId'), req.body),
      })
    }),
  )

  sp.get(
    '/accounts/:accountId/balances',
    'viewer',
    run((req, res) => {
      res.json({ balances: ledger.listBalances(deps, space(req), param(req, 'accountId')) })
    }),
  )

  sp.put(
    '/accounts/:accountId/balances/:date',
    'editor',
    validateBody(setBalanceSchema),
    run((req, res) => {
      const date = isoDateSchema.safeParse(req.params.date)
      if (!date.success) return sendError(res, 400, 'invalid_input')
      res.json({
        balance: ledger.setBalance(deps, space(req), param(req, 'accountId'), date.data, req.body),
      })
    }),
  )

  // ----- Categories -----

  sp.get(
    '/categories',
    'viewer',
    run((req, res) => {
      res.json({
        categories: ledger.listCategories(deps, space(req), req.query.includeArchived === 'true'),
      })
    }),
  )

  sp.post(
    '/categories',
    'editor',
    validateBody(createCategorySchema),
    run((req, res) => {
      res.status(201).json({ category: ledger.createCategory(deps, space(req), req.body) })
    }),
  )

  sp.patch(
    '/categories/:categoryId',
    'editor',
    validateBody(updateCategorySchema),
    run((req, res) => {
      res.json({
        category: ledger.updateCategory(deps, space(req), param(req, 'categoryId'), req.body),
      })
    }),
  )

  // ----- Transactions -----

  sp.get(
    '/transactions',
    'viewer',
    run((req, res) => {
      const q = transactionQuerySchema.safeParse(req.query)
      if (!q.success) return sendError(res, 400, 'invalid_input')
      res.json(ledger.listTransactions(deps, space(req), q.data))
    }),
  )

  sp.post(
    '/transactions',
    'editor',
    validateBody(createTransactionSchema),
    run((req, res) => {
      res
        .status(201)
        .json({ transaction: ledger.createTransaction(deps, actor(req), space(req), req.body) })
    }),
  )

  sp.get(
    '/transactions/:transactionId',
    'viewer',
    run((req, res) => {
      res.json(ledger.getTransaction(deps, space(req), param(req, 'transactionId')))
    }),
  )

  sp.patch(
    '/transactions/:transactionId',
    'editor',
    validateBody(updateTransactionSchema),
    run((req, res) => {
      res.json({
        transaction: ledger.updateTransaction(
          deps,
          actor(req),
          space(req),
          param(req, 'transactionId'),
          req.body,
        ),
      })
    }),
  )

  sp.delete(
    '/transactions/:transactionId',
    'editor',
    run((req, res) => {
      ledger.removeTransaction(deps, space(req), param(req, 'transactionId'))
      res.json({ ok: true })
    }),
  )

  // ----- Transfers -----

  sp.post(
    '/transfers',
    'editor',
    validateBody(linkTransferSchema),
    run((req, res) => {
      const b = req.body as { transactionId: string; otherTransactionId: string }
      res.status(201).json({
        transfer: ledger.linkTransfer(
          deps,
          actor(req),
          space(req),
          b.transactionId,
          b.otherTransactionId,
        ),
      })
    }),
  )

  sp.delete(
    '/transfers/:transactionId',
    'editor',
    run((req, res) => {
      ledger.unlinkTransfer(deps, actor(req), space(req), param(req, 'transactionId'))
      res.json({ ok: true })
    }),
  )
}
