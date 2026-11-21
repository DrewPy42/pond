import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { IDLE_TIMEOUT_MS, REAUTH_WINDOW_MS, hasRecentReauth } from './auth/sessions'
import { auditLog, recoveryCodes, sessions, users } from './db/schema'
import { Client, PASSWORD, bootstrapAdmin, createUser, makeEnv, totpNow } from './testing'

describe('first-run setup', () => {
  it('reports setup required, then refuses everything without the code', async () => {
    const env = makeEnv()
    const c = new Client(env.app)
    expect((await c.get('/api/setup/status')).body).toEqual({ setupRequired: true })
    const bad = await c.post('/api/setup', {
      setupCode: 'WRONG',
      username: 'admin',
      displayName: 'A',
      password: PASSWORD,
    })
    expect(bad.status).toBe(403)
    expect(env.ctx.db.db.select().from(users).all()).toHaveLength(0)
  })

  it('creates the admin once and consumes the code', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    expect(admin.id).toBeTruthy()
    const again = await new Client(env.app).post('/api/setup', {
      setupCode: 'ANYTHING',
      username: 'second',
      displayName: 'Second',
      password: PASSWORD,
    })
    expect(again.status).toBe(404)
    expect((await new Client(env.app).get('/api/setup/status')).body).toEqual({
      setupRequired: false,
    })
  })

  it('has no setup code when a user already exists', () => {
    expect(makeEnv({ withSetupCode: false }).ctx.setupCode.active).toBe(false)
  })

  it('rejects weak passwords', async () => {
    const env = makeEnv()
    const r = await new Client(env.app).post('/api/setup', {
      setupCode: env.ctx.setupCode.reveal(),
      username: 'admin',
      displayName: 'A',
      password: 'short',
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('weak_password')
    // A bad password must not burn the one-time code.
    expect(env.ctx.setupCode.active).toBe(true)
  })

  it('throttles setup-code guessing', async () => {
    const env = makeEnv()
    const c = new Client(env.app)
    const body = { setupCode: 'NOPE', username: 'admin', displayName: 'A', password: PASSWORD }
    for (let i = 0; i < 5; i++) await c.post('/api/setup', body)
    const r = await c.post('/api/setup', { ...body, setupCode: env.ctx.setupCode.reveal() })
    expect(r.status).toBe(429)
  })
})

describe('admin TOTP requirement', () => {
  it('blocks a fresh admin from everything but enrollment until TOTP is confirmed', async () => {
    const env = makeEnv()
    const c = new Client(env.app)
    await c.post('/api/setup', {
      setupCode: env.ctx.setupCode.reveal(),
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

  it('stores the TOTP secret encrypted and recovery codes hashed', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const row = env.ctx.db.db.select().from(users).where(eq(users.id, admin.id)).get()!
    expect(row.totpSecretEnc).toMatch(/^v1:/)
    expect(row.totpSecretEnc).not.toContain(admin.secret!)
    const codes = env.ctx.db.db.select().from(recoveryCodes).all()
    expect(codes).toHaveLength(10)
    for (const c of admin.recoveryCodes!) expect(codes.map((x) => x.codeHash)).not.toContain(c)
  })
})

describe('login', () => {
  it('requires a TOTP code when enabled, and accepts a valid one', async () => {
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

  it('gives the same error for wrong password and unknown user', async () => {
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

  it('recovery codes work exactly once', async () => {
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
    expect(
      env.ctx.db.db.select().from(auditLog).where(eq(auditLog.action, 'auth.lockout')).all().length,
    ).toBeGreaterThan(0)

    // Still locked a little later, allowed after the delay.
    expect((await c.post('/api/auth/login', { username: 'sam', password: PASSWORD })).status).toBe(
      429,
    )
    env.advance(31_000)
    expect((await c.post('/api/auth/login', { username: 'sam', password: PASSWORD })).status).toBe(
      200,
    )
  })

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

describe('sessions', () => {
  it('stores only a hash of the session token', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const token = admin.client.jar.get('pond_session')!
    const ids = env.ctx.db.db
      .select()
      .from(sessions)
      .all()
      .map((s) => s.id)
    expect(ids).not.toContain(token)
    expect(ids.every((id) => /^[0-9a-f]{64}$/.test(id))).toBe(true)
  })

  it('expires after the idle timeout but slides while active', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    env.advance(IDLE_TIMEOUT_MS - 60_000)
    expect((await admin.client.get('/api/auth/me')).status).toBe(200) // slides the window
    env.advance(IDLE_TIMEOUT_MS - 60_000)
    expect((await admin.client.get('/api/auth/me')).status).toBe(200)
    env.advance(IDLE_TIMEOUT_MS + 1000)
    expect((await admin.client.get('/api/auth/me')).status).toBe(401)
  })

  it('enforces the 30-day absolute limit even when active', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    // Keep the session active hourly across 31 days.
    let status = 200
    for (let h = 0; h < 31 * 24 && status === 200; h++) {
      env.advance(60 * 60 * 1000)
      status = (await admin.client.get('/api/auth/me')).status
    }
    expect(status).toBe(401)
  }, 60_000)

  it('logout revokes the session server-side', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const stolen = new Client(env.app)
    stolen.jar = new Map(admin.client.jar)
    await admin.client.post('/api/auth/logout')
    expect((await stolen.get('/api/auth/me')).status).toBe(401)
  })

  it('rejects state-changing requests without a matching CSRF token', async () => {
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

  it('password change revokes other sessions and needs the current password', async () => {
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
    const relog = new Client(env.app)
    expect(
      (await relog.post('/api/auth/login', { username: 'sam', password: 'another-long-pass-9' }))
        .status,
    ).toBe(200)
  })

  it('disabling a user revokes their sessions immediately', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const sam = await createUser(env, admin, 'sam')
    await admin.client.patch(`/api/users/${sam.id}`, { status: 'disabled' })
    expect((await sam.client.get('/api/auth/me')).status).toBe(401)
  })
})

describe('audit log', () => {
  it('records auth events without secrets, and only admins can read it', async () => {
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

    const raw = JSON.stringify(env.ctx.db.db.select().from(auditLog).all())
    expect(raw).not.toContain(PASSWORD)
    expect(raw).not.toContain('wrong-password-123')
    expect(raw).not.toContain(admin.secret!)

    expect((await sam.client.get('/api/audit-log')).status).toBe(403)
    expect((await new Client(env.app).get('/api/audit-log')).status).toBe(401)
  })
})

describe('reauth', () => {
  it('requires the password', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    expect(
      (await admin.client.post('/api/auth/reauth', { password: 'wrong-password-123' })).status,
    ).toBe(401)
    expect((await admin.client.post('/api/auth/reauth', { password: PASSWORD })).status).toBe(200)
    const row = env.ctx.db.db.select().from(sessions).all()[0]!
    expect(row.reauthAt).not.toBeNull()
  })

  it('counts as recent for exactly five minutes', () => {
    const t0 = new Date('2026-01-01T12:00:00Z')
    expect(hasRecentReauth(null, t0)).toBe(false)
    expect(hasRecentReauth(t0.toISOString(), new Date(t0.getTime() + REAUTH_WINDOW_MS))).toBe(true)
    expect(hasRecentReauth(t0.toISOString(), new Date(t0.getTime() + REAUTH_WINDOW_MS + 1))).toBe(
      false,
    )
  })
})
