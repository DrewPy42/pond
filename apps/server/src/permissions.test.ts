import { describe, expect, it } from 'vitest'
import { Client, bootstrapAdmin, createUser, makeEnv, type Account, type TestEnv } from './testing'

/**
 * The permission suite required by docs/security.md and CLAUDE.md: deny by default, 404 (not
 * 403) for non-members so Space existence never leaks, roles enforced, admins see everything.
 */

interface World {
  env: TestEnv
  admin: Account
  owner: Account // owner of A
  editor: Account // editor of A
  viewer: Account // viewer of A
  outsider: Account // member of B only
  loner: Account // no Spaces
  a: string
  b: string
}

async function world(): Promise<World> {
  const env = makeEnv()
  const admin = await bootstrapAdmin(env)
  const owner = await createUser(env, admin, 'alice', '10.0.1.1')
  const editor = await createUser(env, admin, 'bob', '10.0.1.2')
  const viewer = await createUser(env, admin, 'carol', '10.0.1.3')
  const outsider = await createUser(env, admin, 'dave', '10.0.1.4')
  const loner = await createUser(env, admin, 'erin', '10.0.1.5')
  const a = (
    await admin.client.post('/api/spaces', {
      name: 'Home',
      type: 'personal',
      ownerUserId: owner.id,
    })
  ).body.space.id
  const b = (
    await admin.client.post('/api/spaces', {
      name: 'Biz',
      type: 'business',
      ownerUserId: outsider.id,
    })
  ).body.space.id
  await owner.client.put(`/api/spaces/${a}/members/${editor.id}`, { role: 'editor' })
  await owner.client.put(`/api/spaces/${a}/members/${viewer.id}`, { role: 'viewer' })
  return { env, admin, owner, editor, viewer, outsider, loner, a, b }
}

const fill = (path: string, w: World, spaceId: string) =>
  path.replace(':spaceId', spaceId).replace(':userId', w.loner.id)

const bodyFor = (method: string) =>
  method === 'put' ? { role: 'viewer' } : method === 'patch' ? { name: 'Renamed' } : {}

describe('every Space-scoped route', () => {
  it('is registered (the suite below would otherwise prove nothing)', async () => {
    const w = await world()
    expect(w.env.ctx.spaceRoutes.length).toBeGreaterThanOrEqual(5)
  })

  it('returns 401 with no session', async () => {
    const w = await world()
    const anon = new Client(w.env.app)
    for (const r of w.env.ctx.spaceRoutes) {
      const res = await anon.send(r.method, fill(r.path, w, w.a), bodyFor(r.method))
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401)
    }
  })

  it('returns 404 to a non-member, identical to a Space that does not exist', async () => {
    const w = await world()
    for (const who of [w.outsider, w.loner]) {
      for (const r of w.env.ctx.spaceRoutes) {
        const label = `${who.username}: ${r.method.toUpperCase()} ${r.path}`
        const real = await who.client.send(r.method, fill(r.path, w, w.a), bodyFor(r.method))
        const fake = await who.client.send(
          r.method,
          fill(r.path, w, '00000000-0000-7000-8000-000000000000'),
          bodyFor(r.method),
        )
        expect(real.status, label).toBe(404)
        expect(fake.status, label).toBe(404)
        expect(real.body, label).toEqual(fake.body)
      }
    }
  })

  it('enforces the declared minimum role', async () => {
    const w = await world()
    const rank = { viewer: 1, editor: 2, owner: 3 } as const
    for (const [who, role] of [
      [w.viewer, 'viewer'],
      [w.editor, 'editor'],
    ] as const) {
      for (const r of w.env.ctx.spaceRoutes) {
        const res = await who.client.send(r.method, fill(r.path, w, w.a), bodyFor(r.method))
        const label = `${role} ${r.method.toUpperCase()} ${r.path} (needs ${r.minRole})`
        if (rank[role] < rank[r.minRole]) expect(res.status, label).toBe(403)
        else expect([403, 404], label).not.toContain(res.status)
      }
    }
  })

  it('lets admins through everywhere without membership rows', async () => {
    const w = await world()
    for (const r of w.env.ctx.spaceRoutes) {
      const res = await w.admin.client.send(r.method, fill(r.path, w, w.b), bodyFor(r.method))
      expect([401, 403], `${r.method.toUpperCase()} ${r.path}`).not.toContain(res.status)
    }
  })
})

describe('all other API endpoints are closed to anonymous callers', () => {
  const open = new Set([
    'GET /api/health',
    'GET /api/setup/status',
    'POST /api/setup',
    'POST /api/auth/login',
  ])
  const endpoints: [string, string][] = [
    ['get', '/api/auth/me'],
    ['post', '/api/auth/logout'],
    ['post', '/api/auth/totp/enroll'],
    ['post', '/api/auth/totp/confirm'],
    ['post', '/api/auth/password'],
    ['post', '/api/auth/reauth'],
    ['get', '/api/users'],
    ['post', '/api/users'],
    ['patch', '/api/users/some-id'],
    ['get', '/api/spaces'],
    ['post', '/api/spaces'],
    ['get', '/api/audit-log'],
  ]
  it.each(endpoints)('%s %s -> 401', async (method, path) => {
    const w = makeEnv()
    expect(open.has(`${method.toUpperCase()} ${path}`)).toBe(false)
    const res = await new Client(w.app).send(method as 'get', path, {})
    expect(res.status).toBe(401)
  })

  it('unknown /api paths are 404, never a data leak', async () => {
    const res = await new Client(makeEnv().app).get('/api/accounts')
    expect(res.status).toBe(404)
  })
})

describe('Space listing and management', () => {
  it("lists only the caller's Spaces with their role; admins see all", async () => {
    const w = await world()
    const names = async (c: Account) =>
      (await c.client.get('/api/spaces')).body.spaces.map(
        (s: { name: string; role: string }) => `${s.name}:${s.role}`,
      )
    expect(await names(w.owner)).toEqual(['Home:owner'])
    expect(await names(w.viewer)).toEqual(['Home:viewer'])
    expect(await names(w.outsider)).toEqual(['Biz:owner'])
    expect(await names(w.loner)).toEqual([])
    expect((await names(w.admin)).sort()).toEqual(['Biz:owner', 'Home:owner'])
  })

  it('only admins create Spaces', async () => {
    const w = await world()
    expect(
      (await w.owner.client.post('/api/spaces', { name: 'Mine', type: 'personal' })).status,
    ).toBe(403)
  })

  it('owners manage members; editors and viewers cannot', async () => {
    const w = await world()
    const url = `/api/spaces/${w.a}/members/${w.loner.id}`
    expect((await w.editor.client.put(url, { role: 'viewer' })).status).toBe(403)
    expect((await w.owner.client.put(url, { role: 'viewer' })).status).toBe(200)
    expect((await w.loner.client.get(`/api/spaces/${w.a}`)).status).toBe(200)
    expect((await w.owner.client.put(url, { role: 'editor' })).status).toBe(200)
    expect((await w.owner.client.delete(url)).status).toBe(200)
    expect((await w.loner.client.get(`/api/spaces/${w.a}`)).status).toBe(404)
  })

  it('removing a member takes effect immediately', async () => {
    const w = await world()
    expect((await w.viewer.client.get(`/api/spaces/${w.a}`)).status).toBe(200)
    await w.owner.client.delete(`/api/spaces/${w.a}/members/${w.viewer.id}`)
    expect((await w.viewer.client.get(`/api/spaces/${w.a}`)).status).toBe(404)
  })

  it('refuses to remove the last owner', async () => {
    const w = await world()
    const res = await w.owner.client.delete(`/api/spaces/${w.a}/members/${w.owner.id}`)
    expect(res.status).toBe(409)
  })

  it('rejects unknown roles and unknown users', async () => {
    const w = await world()
    expect(
      (await w.owner.client.put(`/api/spaces/${w.a}/members/${w.loner.id}`, { role: 'god' }))
        .status,
    ).toBe(400)
    expect(
      (await w.owner.client.put(`/api/spaces/${w.a}/members/nobody`, { role: 'viewer' })).status,
    ).toBe(400)
  })

  it('audits membership changes with the Space id', async () => {
    const w = await world()
    await w.owner.client.put(`/api/spaces/${w.a}/members/${w.loner.id}`, { role: 'viewer' })
    const log = (await w.admin.client.get('/api/audit-log?limit=200')).body.entries
    const e = log.find((x: { action: string }) => x.action === 'space.member_added')
    expect(e).toMatchObject({ spaceId: w.a, targetId: w.loner.id, meta: { role: 'viewer' } })
  })
})

describe('user management', () => {
  it('is admin-only', async () => {
    const w = await world()
    expect((await w.owner.client.get('/api/users')).status).toBe(403)
    expect(
      (
        await w.owner.client.post('/api/users', {
          username: 'x',
          displayName: 'x',
          password: 'long-enough-pass-1',
        })
      ).status,
    ).toBe(403)
  })

  it('never exposes password hashes or TOTP secrets', async () => {
    const w = await world()
    const raw = JSON.stringify((await w.admin.client.get('/api/users')).body)
    expect(raw).not.toMatch(/argon2|passwordHash|totpSecret|v1:/)
  })

  it('protects the last admin from demotion or disabling', async () => {
    const w = await world()
    expect(
      (await w.admin.client.patch(`/api/users/${w.admin.id}`, { isAdmin: false })).status,
    ).toBe(409)
    expect(
      (await w.admin.client.patch(`/api/users/${w.admin.id}`, { status: 'disabled' })).status,
    ).toBe(409)
  })

  it('rejects duplicate and invalid usernames', async () => {
    const w = await world()
    const mk = (username: string) =>
      w.admin.client.post('/api/users', {
        username,
        displayName: 'x',
        password: 'long-enough-pass-1',
      })
    expect((await mk('alice')).status).toBe(409)
    expect((await mk('A B')).status).toBe(400)
  })
})
