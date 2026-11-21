import { Router } from 'express'
import { healthSchema, type Health } from '@pond/shared'

export function healthRouter(info: () => { version: string; schemaVersion: number }): Router {
  const r = Router()
  r.get('/', (_req, res) => {
    const body: Health = healthSchema.parse({ status: 'ok', ...info() })
    res.json(body)
  })
  return r
}
