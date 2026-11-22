import { describe, expect, it } from 'vitest'
import {
  Client,
  bootstrapAdmin,
  createUser,
  makeEnv,
  type Account,
  type TestEnv,
} from './testing/harness'

/**
 * The permission suite required by docs/security.md and CLAUDE.md: deny by default, 404 (not
 * 403) for non-members so Space existence never leaks, roles enforced, admins see everything.
 * Runs the real app on in-memory fake repositories (no database).
 *
 * The "world" below is the mock data every test uses:
 *   admin   - site administrator (no membership rows; sees every Space)
 *   owner   - "alice", owner of Space A (Home)       editor - "bob", editor of Space A
 *   viewer  - "carol", viewer of Space A             outsider - "dave", owner of Space B only
 *   loner   - "erin", member of no Space at all
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

/** Fills the route's params: the Space, erin's id for :userId, and a made-up id for the rest. */
const fill = (path: string, w: World, spaceId: string) =>
  path
    .replace(':spaceId', spaceId)
    .replace(':userId', w.loner.id)
    .replace(/:[A-Za-z]+/g, '2030-01-01')

const bodyFor = (method: string) =>
  method === 'put' ? { role: 'viewer' } : method === 'patch' ? { name: 'Renamed' } : {}

describe('every Space-scoped route (auto-discovered from createSpaceRouter)', () => {
  /**
   * Function: createSpaceRouter registry (ctx.spaceRoutes)
   * Inputs:   the app built with the standard routes
   * Expected: at least 5 Space-scoped routes are registered; if this were empty, every
   *           "for every route" test below would pass without checking anything
   */
  it('is registered (the suite below would otherwise prove nothing)', async () => {
    const w = await world()
    expect(w.env.ctx.spaceRoutes.length).toBeGreaterThanOrEqual(5)
  })

  /**
   * Function: requireAuth on every Space-scoped route
   * Inputs:   each registered route called with no session cookie
   * Expected: 401 for every one
   */
  it('returns 401 with no session', async () => {
    const w = await world()
    const anon = new Client(w.env.app)
    for (const r of w.env.ctx.spaceRoutes) {
      const res = await anon.send(r.method, fill(r.path, w, w.a), bodyFor(r.method))
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401)
    }
  })

  /**
   * Function: requireSpace(repos, minRole) on every Space-scoped route
   * Inputs:   "dave" (member of Space B only) and "erin" (no Spaces) calling every route for
   *           Space A, and for a Space id that does not exist
   * Expected: 404 in both cases with identical bodies, so nobody can tell whether a Space exists
   */
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

  /**
   * Function: requireSpace(repos, minRole) role check on every Space-scoped route
   * Inputs:   "carol" (viewer) and "bob" (editor) calling every route in Space A
   * Expected: 403 where the route needs a higher role than theirs; never 403 where their role is
   *           enough (a 404 there can be legitimate, e.g. a made-up account id, so it is allowed)
   */
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
        else expect(res.status, label).not.toBe(403)
      }
    }
  })

  /**
   * Function: requireSpace(repos, minRole) admin bypass
   * Inputs:   the admin (no membership rows) calling every route for Space B
   * Expected: never 401 or 403 (admins act as owner in every Space)
   */
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
    ['get', '/api/connections'],
    ['post', '/api/connections'],
    ['post', '/api/connections/some-id/sync'],
    ['post', '/api/connections/some-id/discover'],
    ['patch', '/api/connections/some-id/accounts/acct-id'],
    ['delete', '/api/connections/some-id'],
  ]
  /**
   * Function: requireAuth on every non-public endpoint (listed below)
   * Inputs:   each endpoint called with no session
   * Expected: 401 for all; the only open endpoints are health, setup status, setup and login
   */
  it.each(endpoints)('%s %s -> 401', async (method, path) => {
    const w = makeEnv()
    expect(open.has(`${method.toUpperCase()} ${path}`)).toBe(false)
    const res = await new Client(w.app).send(method as 'get', path, {})
    expect(res.status).toBe(401)
  })

  /**
   * Function: the /api catch-all
   * Inputs:   GET /api/accounts (a path that does not exist yet), with no session
   * Expected: 404
   */
  it('unknown /api paths are 404, never a data leak', async () => {
    const res = await new Client(makeEnv().app).get('/api/accounts')
    expect(res.status).toBe(404)
  })
})

describe('Space listing and member management (/api/spaces)', () => {
  /**
   * Function: GET /api/spaces
   * Inputs:   each user in the world requesting their Space list
   * Expected: alice "Home:owner"; carol "Home:viewer"; dave "Biz:owner"; erin nothing; the
   *           admin sees both Spaces
   */
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

  /**
   * Function: POST /api/spaces
   * Inputs:   alice (a Space owner, not an admin) creating a Space
   * Expected: 403
   */
  it('only admins create Spaces', async () => {
    const w = await world()
    expect(
      (await w.owner.client.post('/api/spaces', { name: 'Mine', type: 'personal' })).status,
    ).toBe(403)
  })

  /**
   * Function: PUT/DELETE /api/spaces/:spaceId/members/:userId
   * Inputs:   bob (editor) then alice (owner) adding "erin" as viewer, changing her to editor,
   *           then removing her
   * Expected: bob gets 403; alice's changes succeed (200); erin can read Space A while a
   *           member and gets 404 once removed
   */
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

  /**
   * Function: DELETE /api/spaces/:spaceId/members/:userId
   * Inputs:   carol (viewer) reads Space A, alice removes her, carol reads again
   * Expected: 200 before removal, 404 after (no stale access)
   */
  it('removing a member takes effect immediately', async () => {
    const w = await world()
    expect((await w.viewer.client.get(`/api/spaces/${w.a}`)).status).toBe(200)
    await w.owner.client.delete(`/api/spaces/${w.a}/members/${w.viewer.id}`)
    expect((await w.viewer.client.get(`/api/spaces/${w.a}`)).status).toBe(404)
  })

  /**
   * Function: DELETE /api/spaces/:spaceId/members/:userId (last-owner guard)
   * Inputs:   alice, the only owner of Space A, removing herself
   * Expected: 409 (a Space can't be left without an owner)
   */
  it('refuses to remove the last owner', async () => {
    const w = await world()
    const res = await w.owner.client.delete(`/api/spaces/${w.a}/members/${w.owner.id}`)
    expect(res.status).toBe(409)
  })

  /**
   * Function: PUT /api/spaces/:spaceId/members/:userId validation
   * Inputs:   role "god"; and a user id that doesn't exist
   * Expected: 400 for both
   */
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

  /**
   * Function: PUT /api/spaces/:spaceId/members/:userId (audit)
   * Inputs:   alice adds erin as viewer
   * Expected: audit entry "space.member_added" with the Space id, erin's id and role "viewer"
   */
  it('audits membership changes with the Space id', async () => {
    const w = await world()
    await w.owner.client.put(`/api/spaces/${w.a}/members/${w.loner.id}`, { role: 'viewer' })
    const log = (await w.admin.client.get('/api/audit-log?limit=200')).body.entries
    const e = log.find((x: { action: string }) => x.action === 'space.member_added')
    expect(e).toMatchObject({ spaceId: w.a, targetId: w.loner.id, meta: { role: 'viewer' } })
  })
})

describe('user management (/api/users)', () => {
  /**
   * Function: GET/POST /api/users
   * Inputs:   alice (not an admin) listing and creating users
   * Expected: 403 for both
   */
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

  /**
   * Function: GET /api/users (response shape)
   * Inputs:   the admin listing users
   * Expected: the JSON contains no password hash, TOTP secret or encrypted value
   */
  it('never exposes password hashes or TOTP secrets', async () => {
    const w = await world()
    const raw = JSON.stringify((await w.admin.client.get('/api/users')).body)
    expect(raw).not.toMatch(/argon2|passwordHash|totpSecret|v1:/)
  })

  /**
   * Function: PATCH /api/users/:userId (last-admin guard)
   * Inputs:   the only admin demoting themselves, then disabling themselves
   * Expected: 409 both times (the install can't lose its last admin)
   */
  it('protects the last admin from demotion or disabling', async () => {
    const w = await world()
    expect(
      (await w.admin.client.patch(`/api/users/${w.admin.id}`, { isAdmin: false })).status,
    ).toBe(409)
    expect(
      (await w.admin.client.patch(`/api/users/${w.admin.id}`, { status: 'disabled' })).status,
    ).toBe(409)
  })

  /**
   * Function: POST /api/users validation
   * Inputs:   username "alice" (taken) and "A B" (invalid characters)
   * Expected: 409 for the duplicate, 400 for the invalid one
   */
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
