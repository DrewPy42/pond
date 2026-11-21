import { randomBytes } from 'node:crypto'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { createCrypto } from './crypto/index'
import { openDb, runMigrations } from './db/index'
import { createLogger } from './logger'

function makeApp() {
  const db = openDb(':memory:')
  runMigrations(db)
  return createApp({ db, crypto: createCrypto(randomBytes(32)), log: createLogger('silent') })
}

describe('app', () => {
  it('serves health with the schema version', async () => {
    const res = await request(makeApp()).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'ok', version: '0.0.0' })
    expect(res.body.schemaVersion).toBeGreaterThan(0)
  })
  it('sets security headers and hides the framework', async () => {
    const res = await request(makeApp()).get('/api/health')
    expect(res.headers['x-powered-by']).toBeUndefined()
    expect(res.headers['content-security-policy']).toBeDefined()
  })
  it('returns 404 JSON for unknown API routes (deny by default)', async () => {
    const res = await request(makeApp()).get('/api/accounts')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })
})
