import express, { type ErrorRequestHandler, type Express } from 'express'
import helmet from 'helmet'
import type { Logger } from 'pino'
import { schemaVersion, type DbHandle } from './db/index.js'
import type { Crypto } from './crypto/index.js'
import { healthRouter } from './routes/health.js'

export const VERSION = '0.0.0'

export interface AppContext {
  db: DbHandle
  crypto: Crypto
  log: Logger
}

export function createApp(ctx: AppContext): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet())
  app.use(express.json({ limit: '1mb' }))

  // Unauthenticated by design: liveness only, no data. Every other /api route goes through the
  // auth middleware added in M1 (CLAUDE.md rule 5). Until then there are no other routes.
  app.use(
    '/api/health',
    healthRouter(() => ({ version: VERSION, schemaVersion: schemaVersion(ctx.db) })),
  )

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' })
  })

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    ctx.log.error({ err: { name: err?.name, message: err?.message } }, 'unhandled error')
    // Never return stack traces or internals to the client.
    res.status(500).json({ error: 'internal_error' })
  }
  app.use(onError)
  return app
}
