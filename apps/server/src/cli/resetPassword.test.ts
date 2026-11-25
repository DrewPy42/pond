/** resetPassword(deps, { username, removeTwoFactor }): recovery from the server console. */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Client, PASSWORD, bootstrapAdmin, makeEnv, totpNow } from '../testing/harness.js'
import { resetPassword } from './resetPassword.js'

const setUp = async () => {
  const env = makeEnv()
  const admin = await bootstrapAdmin(env)
  const reset = (removeTwoFactor: boolean, username = admin.username) =>
    resetPassword(env.ctx, { username, removeTwoFactor })
  const login = (body: object) =>
    new Client(env.app, '10.9.9.9').post('/api/auth/login', { username: admin.username, ...body })
  return { env, admin, reset, login }
}

describe('resetPassword', () => {
  /**
   * Inputs:   a signed-in admin with an authenticator; reset without --remove-2fa
   * Expected: their session ends, the old password stops working, the temporary one works with
   *           the same authenticator, and it is audited without the password
   */
  it('gives a temporary password and signs the user out everywhere', async () => {
    const w = await setUp()
    const result = (await w.reset(false))!
    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(16)
    expect((await w.admin.client.get('/api/auth/me')).status).toBe(401)
    const code = totpNow(w.admin.secret!)
    expect((await w.login({ password: PASSWORD, code })).status).toBe(401)
    expect((await w.login({ password: result.temporaryPassword })).body.error).toBe('totp_required')
    expect((await w.login({ password: result.temporaryPassword, code })).status).toBe(200)
    const log = w.env.ctx.repos.audit.list({ limit: 50 })
    expect(log.map((a) => a.action)).toContain('auth.password_reset_from_console')
    expect(JSON.stringify(log)).not.toContain(result.temporaryPassword)
  })

  /**
   * Inputs:   the same, with --remove-2fa (a lost phone)
   * Expected: no code is asked for, recovery codes are gone, and the admin must set up an
   *           authenticator again before doing anything
   */
  it('can turn off the authenticator, which an admin must then set up again', async () => {
    const w = await setUp()
    const result = (await w.reset(true))!
    const res = await w.login({ password: result.temporaryPassword })
    expect(res.status).toBe(200)
    expect(res.body.totpEnrollmentRequired).toBe(true)
    expect(w.env.ctx.repos.recoveryCodes.countUnused(w.admin.id)).toBe(0)
  })

  /**
   * Inputs:   a username that doesn't exist
   * Expected: null, and the admin's session is untouched
   */
  it('does nothing for an unknown user', async () => {
    const w = await setUp()
    expect(await w.reset(false, 'nobody')).toBeNull()
    expect((await w.admin.client.get('/api/auth/me')).status).toBe(200)
  })

  /**
   * Inputs:   every server source file outside cli/
   * Expected: none imports the reset, so no web route can reach it
   */
  it('is not reachable from the web app', () => {
    const src = path.resolve(__dirname, '..')
    const importers = (fs.readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.startsWith('cli'))
      .filter((f) => /from '.*resetPassword/.test(fs.readFileSync(path.join(src, f), 'utf8')))
    expect(importers).toEqual([])
  })
})
