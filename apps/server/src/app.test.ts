import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { makeEnv } from './testing/harness'

describe('createApp: GET /api/health and API defaults', () => {
  /**
   * Function: GET /api/health
   * Inputs:   an app on fake repositories reporting schema version 1
   * Expected: 200 with { status: "ok", version: "0.0.0", schemaVersion: 1 } and no login needed
   */
  it('reports status, version and schema version', async () => {
    const res = await request(makeEnv().app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', version: '0.0.0', schemaVersion: 1 })
  })

  /**
   * Function: security headers (helmet) on any response
   * Inputs:   GET /api/health
   * Expected: a Content-Security-Policy header is present and "X-Powered-By" is absent
   */
  it('sets security headers and hides the framework', async () => {
    const res = await request(makeEnv().app).get('/api/health')
    expect(res.headers['x-powered-by']).toBeUndefined()
    expect(res.headers['content-security-policy']).toBeDefined()
  })

  /**
   * Function: the /api catch-all (deny by default)
   * Inputs:   GET /api/accounts, a route that doesn't exist yet
   * Expected: 404 with { error: "not_found" }
   */
  it('returns 404 JSON for unknown API routes', async () => {
    const res = await request(makeEnv().app).get('/api/accounts')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })
})
