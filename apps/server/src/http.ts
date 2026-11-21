import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ZodType } from 'zod'

export const SESSION_COOKIE = 'pond_session'
export const CSRF_COOKIE = 'pond_csrf'

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (!k) continue
    try {
      out[k] = decodeURIComponent(v)
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out
}

export function sendError(res: Response, status: number, error: string, extra?: object): void {
  res.status(status).json({ error, ...extra })
}

/** Validate `req.body` with zod at the route boundary (CLAUDE.md rule 8). */
export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      sendError(res, 400, 'invalid_input', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
      return
    }
    req.body = parsed.data
    next()
  }
}

/** Express 5 forwards rejected promises to the error handler, but we keep handlers explicit. */
export const h =
  (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res)
    } catch (e) {
      next(e)
    }
  }
