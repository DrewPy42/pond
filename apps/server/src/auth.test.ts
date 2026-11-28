import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { IDLE_TIMEOUT_MS, REAUTH_WINDOW_MS, hasRecentReauth, sha256 } from './auth/sessions'
import { Client, PASSWORD, bootstrapAdmin, createUser, makeEnv, totpNow } from './testing/harness'

/**
 * Functionality tests for the identity routes. They run the real app against in-memory fake
 * repositories (no database), a fixed clock, and a cookie-jar Client that sends the session
 * and CSRF cookies like a browser. PASSWORD is a valid 12+ character test password.
 */

describe('GET /api/setup/status and POST /api/setup (first-run admin creation)', () => {
  const body = { username: 'admin', displayName: 'A', password: PASSWORD }

  /**
   * Inputs:   a new install (no users), and a setup request with no code of any kind
   * Expected: setup is offered, the admin is created, and then setup is no longer offered
   */
  it('lets whoever opens a new Pond first create the admin', async () => {
    const env = makeEnv()
    const c = new Client(env.app)
    expect((await c.get('/api/setup/status')).body).toEqual({ setupRequired: true })
    const res = await c.post('/api/setup', body)
    expect(res.status).toBe(201)
    expect(res.body.user).toMatchObject({ username: 'admin', isAdmin: true })
    expect((await c.get('/api/setup/status')).body).toEqual({ setupRequired: false })
  })

  /**
   * Inputs:   a second setup request after the admin exists; also an install whose only account
   *           is an ordinary user
   * Expected: 404 both times and no new account: setup closes once any account exists
   */
  it('is closed once any account exists', async () => {
    const env = makeEnv()
    await bootstrapAdmin(env)
    const again = await new Client(env.app).post('/api/setup', { ...body, username: 'second' })
    expect(again.status).toBe(404)
    expect(env.ctx.repos.users.count()).toBe(1)

    const other = makeEnv()
    other.ctx.repos.users.create({
      id: 'u',
      username: 'ann',
      displayName: 'Ann',
      passwordHash: 'h',
      isAdmin: false,
    })
    expect((await new Client(other.app).get('/api/setup/status')).body).toEqual({
      setupRequired: false,
    })
    expect((await new Client(other.app).post('/api/setup', body)).status).toBe(404)
  })

  /**
   * Inputs:   two setup requests for different names, sent at the same moment
   * Expected: exactly one succeeds, and there is one account
   */
  it('creates only one admin when two people set up at once', async () => {
    const env = makeEnv()
    const results = await Promise.all(
      ['first', 'second'].map((username) =>
        new Client(env.app).post('/api/setup', { ...body, username }),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual([201, 404])
    expect(env.ctx.repos.users.count()).toBe(1)
  })

  /**
   * Inputs:   password "short", then a good one
   * Expected: 400 weak_password with nothing created, then success
   */
  it('refuses a weak password and stays open', async () => {
    const env = makeEnv()
    const c = new Client(env.app)
    const weak = await c.post('/api/setup', { ...body, password: 'short' })
    expect(weak.status).toBe(400)
    expect(weak.body.error).toBe('weak_password')
    expect(env.ctx.repos.users.count()).toBe(0)
    expect((await c.post('/api/setup', body)).status).toBe(201)
  })

  /**
   * Inputs:   setup requests the browser marks "cross-site" (another website) or "same-site"
   *           (another app on the same machine, on another port)
   * Expected: 403 cross_origin and no account
   */
  it.each(['cross-site', 'same-site', 'anything-else'])(
    'refuses a request the browser marks %s',
    async (site) => {
      const env = makeEnv()
      const res = await request(env.app).post('/api/setup').set('Sec-Fetch-Site', site).send(body)
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('cross_origin')
      expect(env.ctx.repos.users.count()).toBe(0)
    },
  )

  /**
   * Inputs:   setup marked "same-origin" (Pond's own page), "none" (the person's own action),
   *           and with no header (not a browser, or plain HTTP)
   * Expected: each one is accepted
   */
  it.each(['same-origin', 'none', undefined])('accepts Sec-Fetch-Site %s', async (site) => {
    const env = makeEnv()
    const send = request(env.app).post('/api/setup')
    const res = await (site ? send.set('Sec-Fetch-Site', site) : send).send(body)
    expect(res.status).toBe(201)
  })

  /**
   * Inputs:   what another website can send without asking first (a form-style or plain-text
   *           body), and the browser's "may I send JSON?" question from another site
   * Expected: nothing is created, and Pond never says another origin is allowed
   */
  it('gives another website no way to send setup', async () => {
    const env = makeEnv()
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await request(env.app)
        .post('/api/setup')
        .set('Content-Type', type)
        .send(type === 'text/plain' ? JSON.stringify(body) : new URLSearchParams(body).toString())
      expect(res.status, type).toBe(400)
    }
    const asked = await request(env.app)
      .options('/api/setup')
      .set('Origin', 'https://elsewhere.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
    expect(asked.headers['access-control-allow-origin']).toBeUndefined()
    expect(env.ctx.repos.users.count()).toBe(0)
  })
})

describe('POST /api/auth/totp/enroll: the name of the authenticator entry', () => {
  /** The name an authenticator app gets when two-step sign-in is set up at this address. */
  async function entryFor(host: string) {
    const env = makeEnv()
    const c = new Client(env.app)
    await c.post('/api/setup', { username: 'ann', displayName: 'A', password: PASSWORD })
    const cookie = [...c.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
    const res = await request(env.app)
      .post('/api/auth/totp/enroll')
      .set('Host', host)
      .set('Cookie', cookie)
      .set('x-csrf-token', c.jar.get('pond_csrf')!)
      .send({})
    const uri = new URL(res.body.uri)
    return {
      label: decodeURIComponent(uri.pathname.slice(1)),
      issuer: uri.searchParams.get('issuer'),
      secret: uri.searchParams.get('secret') === res.body.secret,
    }
  }

  /**
   * Inputs:   enrollment reached as pond.local, 192.168.1.20, Pi.local:8443 and localhost:3210
   * Expected: the entry names that address (lower case, no port, which an entry name can't
   *           hold), so two installs don't look alike; the secret is unchanged
   */
  it.each([
    ['pond.local', 'pond.local'],
    ['192.168.1.20', '192.168.1.20'],
    ['Pi.local:8443', 'pi.local'],
    ['localhost:3210', 'localhost'],
  ])('names the address for %s', async (host, shown) => {
    expect(await entryFor(host)).toEqual({
      label: `Pond (${shown}):ann`,
      issuer: `Pond (${shown})`,
      secret: true,
    })
  })

  /**
   * Inputs:   an IPv6 address (its colons would split the name), a name with other characters,
   *           and one far too long
   * Expected: the entry is just "Pond"
   */
  it.each(['[fd00::1]:443', 'bad_host:label?x=1', `${'a'.repeat(120)}.local`])(
    'falls back to "Pond" for %s',
    async (host) => {
      expect(await entryFor(host)).toEqual({ label: 'Pond:ann', issuer: 'Pond', secret: true })
    },
  )
})

describe('authenticator codes typed with spaces', () => {
  /**
   * Inputs:   the right code written as many authenticators show it, "123 456", both when
   *           turning two-step sign-in on and when signing in
   * Expected: accepted both times; the space changes nothing
   */
  it('accepts a code with a space in it', async () => {
    const env = makeEnv()
    const c = new Client(env.app)
    await c.post('/api/setup', { username: 'admin', displayName: 'A', password: PASSWORD })
    const { secret } = (await c.post('/api/auth/totp/enroll')).body
    const spaced = () => ` ${totpNow(secret).slice(0, 3)} ${totpNow(secret).slice(3)} `
    expect((await c.post('/api/auth/totp/confirm', { code: spaced() })).status).toBe(200)
    const again = await new Client(env.app).post('/api/auth/login', {
      username: 'admin',
      password: PASSWORD,
      code: spaced(),
    })
    expect(again.status).toBe(200)
  })

  /**
   * Inputs:   five digits and a space, and a recovery code (letters, digits and a dash)
   * Expected: the short code is refused; the recovery code still works
   */
  it('still refuses a short code and accepts recovery codes', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const login = (code: string) =>
      new Client(env.app).post('/api/auth/login', {
        username: 'admin',
        password: PASSWORD,
        code,
      })
    expect((await login('123 45')).status).toBe(401)
    expect((await login(admin.recoveryCodes![0]!)).status).toBe(200)
  })
})

describe('admin TOTP requirement (POST /api/auth/totp/enroll and /confirm)', () => {
  /**
   * Inputs:   a brand-new admin session; enroll, a wrong code "000000", then the right code
   * Expected: until confirmed, /api/users and /api/spaces return 403 totp_enrollment_required;
   *           the wrong code gives 400; the right code gives 10 recovery codes and unlocks the API
   */
  it('blocks a new admin from everything but enrollment until TOTP is confirmed', async () => {
    const env = makeEnv()
    const c = new Client(env.app)
    await c.post('/api/setup', {
      username: 'admin',
      displayName: 'A',
      password: PASSWORD,
    })
    expect((await c.get('/api/auth/me')).body.totpEnrollmentRequired).toBe(true)
    expect((await c.get('/api/users')).body.error).toBe('totp_enrollment_required')
    expect((await c.get('/api/spaces')).status).toBe(403)

    const enroll = await c.post('/api/auth/totp/enroll')
    expect((await c.post('/api/auth/totp/confirm', { code: '000000' })).status).toBe(400)
    const ok = await c.post('/api/auth/totp/confirm', { code: totpNow(enroll.body.secret) })
    expect(ok.status).toBe(200)
    expect(ok.body.recoveryCodes).toHaveLength(10)
    expect((await c.get('/api/users')).status).toBe(200)
  })

  /**
   * Inputs:   a fully enrolled admin (secret and 10 recovery codes shown to the user once)
   * Expected: the stored secret is encrypted ("v1:" prefix, plaintext absent); the repository
   *           holds 10 unused codes but none of the plain codes can be found (only hashes stored)
   */
  it('stores the TOTP secret encrypted and recovery codes only as hashes', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const row = env.ctx.repos.users.findById(admin.id)!
    expect(row.totpSecretEnc).toMatch(/^v1:/)
    expect(row.totpSecretEnc).not.toContain(admin.secret!)
    expect(env.ctx.repos.recoveryCodes.countUnused(admin.id)).toBe(10)
    for (const plain of admin.recoveryCodes!) {
      expect(env.ctx.repos.recoveryCodes.findUnused(admin.id, plain)).toBeUndefined()
    }
  })
})

describe('POST /api/auth/login', () => {
  /**
   * Inputs:   admin with TOTP; login with password only, then a wrong code, then a valid code
   * Expected: 401 totp_required; 401; then 200 with the user (no password hash in the response)
   *           and a session that works on /api/auth/me
   */
  it('requires a TOTP code when enabled and accepts a valid one', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const c = new Client(env.app)
    expect(
      (await c.post('/api/auth/login', { username: 'admin', password: PASSWORD })).body.error,
    ).toBe('totp_required')
    expect(
      (await c.post('/api/auth/login', { username: 'admin', password: PASSWORD, code: '123456' }))
        .status,
    ).toBe(401)
    const ok = await c.post('/api/auth/login', {
      username: 'admin',
      password: PASSWORD,
      code: totpNow(admin.secret!),
    })
    expect(ok.status).toBe(200)
    expect(ok.body.user.username).toBe('admin')
    expect(ok.body.user).not.toHaveProperty('passwordHash')
    expect((await c.get('/api/auth/me')).status).toBe(200)
  })

  /**
   * Inputs:   a wrong password for a real user, and any password for a user that doesn't exist
   * Expected: identical 401 responses, so the error never reveals which usernames exist
   */
  it('gives the same error for a wrong password and an unknown user', async () => {
    const env = makeEnv()
    await bootstrapAdmin(env)
    const c = new Client(env.app)
    const a = await c.post('/api/auth/login', { username: 'admin', password: 'wrong-password-123' })
    const b = await c.post('/api/auth/login', {
      username: 'nobody',
      password: 'wrong-password-123',
    })
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(a.body).toEqual(b.body)
  })

  /**
   * Inputs:   the same recovery code used to log in twice
   * Expected: first login 200; second login 401 (a recovery code works exactly once)
   */
  it('accepts each recovery code only once', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const code = admin.recoveryCodes![0]!
    expect(
      (
        await new Client(env.app).post('/api/auth/login', {
          username: 'admin',
          password: PASSWORD,
          code,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await new Client(env.app).post('/api/auth/login', {
          username: 'admin',
          password: PASSWORD,
          code,
        })
      ).status,
    ).toBe(401)
  })

  /**
   * Inputs:   five wrong-password logins from one IP for user "sam", then the correct password;
   *           then 31 seconds later the correct password again (fixed clock advanced)
   * Expected: the sixth attempt is 429 with a Retry-After header and an "auth.lockout" audit
   *           entry; it stays locked; after the delay the correct password succeeds (200)
   */
  it('locks out after repeated failures, backs off, and audits the lockout', async () => {
    const env = makeEnv()
    await createUser(env, await bootstrapAdmin(env), 'sam')
    const c = new Client(env.app, '10.9.9.9')
    for (let i = 0; i < 5; i++) {
      expect(
        (await c.post('/api/auth/login', { username: 'sam', password: 'wrong-password-123' }))
          .status,
      ).toBe(401)
    }
    const locked = await c.post('/api/auth/login', { username: 'sam', password: PASSWORD })
    expect(locked.status).toBe(429)
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0)
    const actions = env.ctx.repos.audit.list({ limit: 200 }).map((e) => e.action)
    expect(actions).toContain('auth.lockout')

    expect((await c.post('/api/auth/login', { username: 'sam', password: PASSWORD })).status).toBe(
      429,
    )
    env.advance(31_000)
    expect((await c.post('/api/auth/login', { username: 'sam', password: PASSWORD })).status).toBe(
      200,
    )
  })

  /**
   * Inputs:   a user the admin has disabled, logging in with the correct password
   * Expected: 401 (a disabled account can't sign in)
   */
  it('refuses disabled users', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const sam = await createUser(env, admin, 'sam')
    await admin.client.patch(`/api/users/${sam.id}`, { status: 'disabled' })
    expect(
      (await new Client(env.app).post('/api/auth/login', { username: 'sam', password: PASSWORD }))
        .status,
    ).toBe(401)
  })
})

describe('sessions (cookie, idle and absolute limits, logout, CSRF)', () => {
  /**
   * Inputs:   a signed-in admin's session cookie value (the raw token)
   * Expected: the repository has no session under the raw token, only under its SHA-256 hash,
   *           so a database leak does not leak usable tokens
   */
  it('stores only a hash of the session token', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const token = admin.client.jar.get('pond_session')!
    expect(env.ctx.repos.sessions.findWithUser(token)).toBeUndefined()
    expect(env.ctx.repos.sessions.findWithUser(sha256(token))).toBeDefined()
  })

  /**
   * Inputs:   requests made just inside the 12-hour idle window (twice), then 12h + 1s of silence
   * Expected: the first two succeed and each slides the window forward; the last gets 401
   */
  it('expires after the idle timeout but slides while the user is active', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    env.advance(IDLE_TIMEOUT_MS - 60_000)
    expect((await admin.client.get('/api/auth/me')).status).toBe(200)
    env.advance(IDLE_TIMEOUT_MS - 60_000)
    expect((await admin.client.get('/api/auth/me')).status).toBe(200)
    env.advance(IDLE_TIMEOUT_MS + 1000)
    expect((await admin.client.get('/api/auth/me')).status).toBe(401)
  })

  /**
   * Inputs:   a session kept active with a request every hour for 31 days
   * Expected: eventually 401: the 30-day absolute limit applies even to an active session
   */
  it('enforces the 30-day absolute limit even when active', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    let status = 200
    for (let hour = 0; hour < 31 * 24 && status === 200; hour++) {
      env.advance(60 * 60 * 1000)
      status = (await admin.client.get('/api/auth/me')).status
    }
    expect(status).toBe(401)
  }, 60_000)

  /**
   * Inputs:   a copy of the session cookies taken before POST /api/auth/logout
   * Expected: the copied (stolen) cookies get 401 afterwards: logout revokes it server-side
   */
  it('revokes the session on the server at logout', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const stolen = new Client(env.app)
    stolen.jar = new Map(admin.client.jar)
    await admin.client.post('/api/auth/logout')
    expect((await stolen.get('/api/auth/me')).status).toBe(401)
  })

  /**
   * Inputs:   POST /api/spaces with a valid session but no x-csrf-token header, then with it
   * Expected: 403 csrf_failed without the header; 201 with it
   */
  it('rejects state-changing requests that lack the CSRF token', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    expect(
      (
        await admin.client.send(
          'post',
          '/api/spaces',
          { name: 'X', type: 'personal' },
          { csrf: false },
        )
      ).status,
    ).toBe(403)
    expect((await admin.client.post('/api/spaces', { name: 'X', type: 'personal' })).status).toBe(
      201,
    )
  })

  /**
   * Inputs:   user "sam" with two sessions; POST /api/auth/password with a wrong current
   *           password, then the right one and a new strong password
   * Expected: wrong current -> 401; right -> 200. Sam's other session is revoked (401), the
   *           current one stays valid, and the new password works for a fresh login
   */
  it('changes the password, needing the current one, and revokes other sessions', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const sam = await createUser(env, admin, 'sam')
    const other = new Client(env.app, '10.0.0.3')
    await other.post('/api/auth/login', { username: 'sam', password: PASSWORD })
    expect(
      (
        await sam.client.post('/api/auth/password', {
          currentPassword: 'nope-nope-nope-1',
          newPassword: 'another-long-pass-9',
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await sam.client.post('/api/auth/password', {
          currentPassword: PASSWORD,
          newPassword: 'another-long-pass-9',
        })
      ).status,
    ).toBe(200)
    expect((await other.get('/api/auth/me')).status).toBe(401)
    expect((await sam.client.get('/api/auth/me')).status).toBe(200)
    expect(
      (
        await new Client(env.app).post('/api/auth/login', {
          username: 'sam',
          password: 'another-long-pass-9',
        })
      ).status,
    ).toBe(200)
  })

  /**
   * Inputs:   user "sam" signed in; the admin disables sam
   * Expected: sam's existing session gets 401 immediately
   */
  it("ends a user's sessions at once when an admin disables them", async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const sam = await createUser(env, admin, 'sam')
    await admin.client.patch(`/api/users/${sam.id}`, { status: 'disabled' })
    expect((await sam.client.get('/api/auth/me')).status).toBe(401)
  })
})

describe('GET /api/audit-log (and what is written to it)', () => {
  /**
   * Inputs:   an admin who set up TOTP, created user "sam", and saw one failed login
   * Expected: the log has setup, TOTP, user-created, login and login-failed entries; none of the
   *           password, the wrong password or the TOTP secret appears anywhere in it; a
   *           non-admin gets 403 and an anonymous caller gets 401
   */
  it('records auth events without secrets and is admin-only', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const sam = await createUser(env, admin, 'sam')
    await new Client(env.app).post('/api/auth/login', {
      username: 'sam',
      password: 'wrong-password-123',
    })

    const log = await admin.client.get('/api/audit-log?limit=100')
    expect(log.status).toBe(200)
    const actions = log.body.entries.map((e: { action: string }) => e.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'setup.admin_created',
        'auth.totp_enabled',
        'user.created',
        'auth.login',
        'auth.login_failed',
      ]),
    )

    const raw = JSON.stringify(env.ctx.repos.audit.list({ limit: 500 }))
    expect(raw).not.toContain(PASSWORD)
    expect(raw).not.toContain('wrong-password-123')
    expect(raw).not.toContain(admin.secret!)

    const first = await admin.client.get('/api/audit-log?limit=1')
    const [newest] = first.body.entries
    const next = await admin.client.get(
      `/api/audit-log?limit=1&before=${encodeURIComponent(newest.at)}&beforeId=${newest.id}`,
    )
    expect(next.body.entries).toHaveLength(1)
    expect(next.body.entries[0].id).not.toBe(newest.id) // carries on, though the times can match

    expect((await sam.client.get('/api/audit-log')).status).toBe(403)
    expect((await new Client(env.app).get('/api/audit-log')).status).toBe(401)
  })
})

describe('POST /api/auth/reauth and hasRecentReauth(reauthAt, now)', () => {
  /**
   * Inputs:   a wrong password, then the right password
   * Expected: 401, then 200 and the session records a reauth time
   */
  it('needs the password and records the time', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    expect(
      (await admin.client.post('/api/auth/reauth', { password: 'wrong-password-123' })).status,
    ).toBe(401)
    expect((await admin.client.post('/api/auth/reauth', { password: PASSWORD })).status).toBe(200)
    const token = admin.client.jar.get('pond_session')!
    expect(env.ctx.repos.sessions.findWithUser(sha256(token))!.session.reauthAt).not.toBeNull()
  })

  /**
   * Inputs:   a re-auth at 12:00; "now" = 12:05:00 and 12:05:00.001; and a null re-auth time
   * Expected: recent at exactly 5 minutes, not recent 1 ms later, not recent when never re-authed
   */
  it('counts as recent for exactly five minutes', () => {
    const t0 = new Date('2026-01-01T12:00:00Z')
    expect(hasRecentReauth(null, t0)).toBe(false)
    expect(hasRecentReauth(t0.toISOString(), new Date(t0.getTime() + REAUTH_WINDOW_MS))).toBe(true)
    expect(hasRecentReauth(t0.toISOString(), new Date(t0.getTime() + REAUTH_WINDOW_MS + 1))).toBe(
      false,
    )
  })
})
