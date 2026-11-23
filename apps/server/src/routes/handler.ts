import type { Request, RequestHandler, Response } from 'express'
import { sendError } from '../http.js'
import { LedgerError } from '../ledger/service.js'
import { DuplicateError, MissingParentError } from '../repos/types.js'

/**
 * Wraps a route handler so domain errors become responses: LedgerError carries its own status
 * and code; a missing parent row is a 400; a duplicate is a 409. Anything else is a real bug and
 * goes to the error handler (which returns a plain 500 with no details).
 */
export const domainHandler =
  (fn: (req: Request, res: Response) => void): RequestHandler =>
  (req, res, next) => {
    try {
      fn(req, res)
    } catch (e) {
      if (e instanceof LedgerError) return sendError(res, e.status, e.code, e.extra)
      if (e instanceof MissingParentError) return sendError(res, 400, 'unknown_reference')
      if (e instanceof DuplicateError) return sendError(res, 409, 'duplicate')
      next(e)
    }
  }
