import express, { type ErrorRequestHandler, type Express } from 'express'
import helmet from 'helmet'
import type { AppContext } from './context.js'
import { csrfGuard, sessionMiddleware } from './middleware/auth.js'
import { auditRouter } from './routes/audit.js'
import { authRouter } from './routes/auth.js'
import { connectionsRouter } from './routes/connections.js'
import { healthRouter } from './routes/health.js'
import { spacesRouter } from './routes/spaces.js'
import { usersRouter } from './routes/users.js'

export const VERSION = '0.0.0'

export type { AppContext }

export function createApp(ctx: AppContext): Express {
  const app = express()
  app.disable('x-powered-by')
  // Caddy (a separate container on a private network) terminates TLS in front of us.
  app.set('trust proxy', 'uniquelocal')
  app.use(helmet())
  app.use(express.json({ limit: '1mb' }))

  // Unauthenticated by design: liveness only, no data.
  app.use(
    '/api/health',
    healthRouter(() => ({ version: VERSION, schemaVersion: ctx.repos.system.schemaVersion() })),
  )

  app.use('/api', sessionMiddleware(ctx.repos, ctx.now), csrfGuard)

  // Every route below is deny-by-default: it declares requireAuth / requireAdmin / the Space
  // router itself. Only setup status/creation and login are open, and each is guarded inside.
  app.use('/api', authRouter(ctx))
  app.use('/api/users', usersRouter(ctx))
  app.use('/api/spaces', spacesRouter(ctx))
  app.use('/api/audit-log', auditRouter(ctx))
  app.use('/api/connections', connectionsRouter(ctx))

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
