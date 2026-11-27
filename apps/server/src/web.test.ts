import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { makeEnv } from './testing/harness'
import { webRouter } from './web'

/** A tiny stand-in for the built web app. Beside it is a file that must never be served. */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-web-'))
const webDir = path.join(temp, 'dist')
const PAGE = '<!doctype html><div id="app"></div>'
fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true })
fs.mkdirSync(path.join(webDir, 'brand'))
fs.writeFileSync(path.join(webDir, 'index.html'), PAGE)
fs.writeFileSync(path.join(webDir, 'assets', 'index-AbC123.js'), 'console.log(1)')
fs.writeFileSync(path.join(webDir, 'brand', 'favicon.svg'), '<svg/>')
fs.writeFileSync(path.join(webDir, '.env'), 'HIDDEN=1')
fs.writeFileSync(path.join(temp, 'master.key'), 'not for the web')
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }))

const app = () => createApp({ ...makeEnv().ctx, spaceRoutes: [], webDir })

describe('webRouter: page addresses', () => {
  /**
   * Inputs:   GET /, /settings, /p/business/reports and /index.html, with no sign-in
   * Expected: 200 with the web app's page each time, to be rechecked on every visit, so an
   *           update shows up at once
   */
  it.each(['/', '/settings', '/p/business/reports', '/index.html'])(
    'answers %s with the page',
    async (url) => {
      const res = await request(app()).get(url)
      expect(res.status).toBe(200)
      expect(res.text).toBe(PAGE)
      expect(res.headers['content-type']).toMatch(/text\/html/)
      expect(res.headers['cache-control']).toBe('no-cache')
    },
  )

  /**
   * Inputs:   HEAD /settings and POST /settings
   * Expected: HEAD succeeds; POST is a 404, because only reading a page is allowed
   */
  it('answers only reads with the page', async () => {
    expect((await request(app()).head('/settings')).status).toBe(200)
    const post = await request(app()).post('/settings')
    expect(post.status).toBe(404)
    expect(post.text).not.toContain(PAGE)
  })

  /**
   * Inputs:   GET / and GET /api/health on an app serving the web app
   * Expected: both carry a Content-Security-Policy allowing scripts only from Pond itself
   */
  it('sends the security headers with pages and the API', async () => {
    for (const url of ['/', '/api/health']) {
      const res = await request(app()).get(url)
      expect(res.headers['content-security-policy']).toContain("script-src 'self';")
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    }
  })
})

describe('webRouter: files', () => {
  /**
   * Inputs:   GET /assets/index-AbC123.js (a hashed name) and /brand/favicon.svg (a fixed name)
   * Expected: both are served; only the hashed file may be kept for a year without asking again
   */
  it('lets browsers keep only the hashed files', async () => {
    const hashed = await request(app()).get('/assets/index-AbC123.js')
    expect(hashed.status).toBe(200)
    expect(hashed.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    const fixed = await request(app()).get('/brand/favicon.svg')
    expect(fixed.status).toBe(200)
    expect(fixed.headers['cache-control']).toBe('no-cache')
  })

  /**
   * Inputs:   a hashed file that no longer exists, a folder under assets and a missing image
   * Expected: 404 and not the page, so a tab left open through an update fails plainly
   */
  it.each(['/assets/index-Old999.js', '/assets/older', '/brand/missing.svg'])(
    'answers the missing file %s with a 404',
    async (url) => {
      const res = await request(app()).get(url)
      expect(res.status).toBe(404)
      expect(res.text).not.toContain(PAGE)
    },
  )

  /**
   * Inputs:   addresses that try to reach a hidden file, or a file outside the web folder
   * Expected: neither file's contents are ever returned
   */
  it.each(['/.env', '/../master.key', '/%2e%2e/master.key', '/assets/..%2f..%2fmaster.key'])(
    'never serves %s',
    async (url) => {
      const res = await request(app()).get(url)
      expect(res.text ?? '').not.toContain('not for the web')
      expect(res.text ?? '').not.toContain('HIDDEN=1')
    },
  )
})

describe('webRouter: the API is never answered with a page', () => {
  /**
   * Inputs:   GET /api, /api/nothing-here and /API/nothing-here, which don't exist
   * Expected: 404 JSON, never the web page
   */
  it.each(['/api', '/api/nothing-here', '/API/nothing-here'])('keeps %s as JSON', async (url) => {
    const res = await request(app()).get(url)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  /**
   * Inputs:   an app with no web folder, as in development
   * Expected: GET / is a 404
   */
  it('serves no pages when there is no web folder', async () => {
    expect((await request(makeEnv().app).get('/')).status).toBe(404)
  })

  /**
   * Inputs:   a web folder with no index.html (the web app was never built)
   * Expected: an error naming POND_WEB_DIR, so Pond stops at startup instead of serving nothing
   */
  it('refuses a folder with no built web app', () => {
    expect(() => webRouter(path.join(webDir, 'assets'))).toThrow(/POND_WEB_DIR/)
  })
})
