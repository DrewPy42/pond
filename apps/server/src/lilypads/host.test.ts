import type { PadModule } from '@pond/sdk'
import { describe, expect, it } from 'vitest'
import {
  Client,
  bootstrapAdmin,
  createUser,
  makeEnv,
  type Account,
  type TestEnv,
} from '../testing/harness'
import { makeFixturePad, type FixtureOptions } from '../testing/fixturePad'

/**
 * LilyPad host tests (docs/lilypad-host-design.md). The real app runs on in-memory fakes with
 * real sessions, CSRF and the Space permission middleware. Pads are the adversarial "fixture"
 * pad (testing/fixturePad.ts); every call between pad and Pond is checked to be plain JSON.
 *
 * Mock data: "admin" (site admin), "olga" (owner of Space HOME), "ann" (editor of HOME), "val" (viewer of
 * HOME), "outsider" (no Spaces); HOME is personal and BIZ is a business Space owned by olga.
 */

interface World {
  env: TestEnv
  admin: Account
  olga: Account
  ann: Account
  val: Account
  outsider: Account
  home: string
  biz: string
}

async function world(pads: PadModule[] = [makeFixturePad()], limit?: number): Promise<World> {
  const env = makeEnv({ pads, padFailureLimit: limit })
  const admin = await bootstrapAdmin(env)
  const [olga, ann, val, outsider] = [
    await createUser(env, admin, 'olga', '10.1.0.1'),
    await createUser(env, admin, 'ann', '10.1.0.2'),
    await createUser(env, admin, 'val', '10.1.0.3'),
    await createUser(env, admin, 'outsider', '10.1.0.4'),
  ]
  const home = (
    await admin.client.post('/api/spaces', { name: 'Home', type: 'personal', ownerUserId: olga.id })
  ).body.space.id
  const biz = (
    await admin.client.post('/api/spaces', { name: 'Biz', type: 'business', ownerUserId: olga.id })
  ).body.space.id
  await olga.client.put(`/api/spaces/${home}/members/${ann.id}`, { role: 'editor' })
  await olga.client.put(`/api/spaces/${home}/members/${val.id}`, { role: 'viewer' })
  return { env, admin, olga, ann, val, outsider, home, biz }
}

const url = (space: string, id: string, path: string) =>
  `/api/spaces/${space}/lilypads/${id}${path}`
const manifestPerms = (w: World, id = 'fixture') =>
  w.env.padHost
    .list()
    .find((p) => p.id === id)!
    .permissions.map((p) => p.permission)
const install = (w: World, id = 'fixture') =>
  w.admin.client.post(`/api/lilypads/${id}/install`, { permissions: manifestPerms(w, id) })
const enable = (w: World, space: string, id = 'fixture', on = true) =>
  w.olga.client.put(`/api/spaces/${space}/pads/${id}/enabled`, { enabled: on })
async function ready(w: World, id = 'fixture') {
  expect((await install(w, id)).status).toBe(200)
  expect((await enable(w, w.home, id)).status).toBe(200)
}

describe('listing and installing pads (admin)', () => {
  /**
   * Function: GET /api/lilypads
   * Inputs:   a pad that reads transactions and accounts, and a pad that asks for no permissions
   * Expected: both listed as "available" and not installed, each permission with a plain-language description;
   *           the permission-free pad is marked as not touching finances
   */
  it('lists available pads with their permissions in plain words', async () => {
    const w = await world([makeFixturePad(), makeFixturePad({ id: 'quiet', permissions: [] })])
    const list = (await w.admin.client.get('/api/lilypads')).body.pads
    const fx = list.find((p: { id: string }) => p.id === 'fixture')
    expect(fx).toMatchObject({ state: 'available', installed: false, touchesFinances: true })
    expect(fx.permissions[0].description).toMatch(/Read your transactions/)
    expect(list.find((p: { id: string }) => p.id === 'quiet')).toMatchObject({
      touchesFinances: false,
      permissions: [],
    })
  })

  /**
   * Function: POST /api/lilypads/:padId/install (approval of permissions)
   * Inputs:   an admin approving too few permissions, too many, and exactly the right set
   * Expected: 409 permissions_mismatch listing what is required (twice); then 200 with the pad running, its
   *           tables created by its migrations, and "lilypad.installed" in the audit log
   */
  it("requires the admin to approve exactly the pad's permissions", async () => {
    const w = await world()
    const all = manifestPerms(w)
    const few = await w.admin.client.post('/api/lilypads/fixture/install', {
      permissions: all.slice(1),
    })
    expect(few.status).toBe(409)
    expect(few.body).toMatchObject({ error: 'permissions_mismatch', required: [...all].sort() })
    expect(
      (
        await w.admin.client.post('/api/lilypads/fixture/install', {
          permissions: [...all, 'transactions:write'],
        })
      ).status,
    ).toBe(409)
    const ok = await install(w)
    expect(ok.body.pad).toMatchObject({ state: 'running', installed: true, problem: null }) // a healthy pad reports no problem
    expect(w.env.ctx.repos.pads.migrations.applied('fixture')).toEqual(['0001_init'])
    expect(w.env.ctx.repos.audit.list({ limit: 50 }).map((a) => a.action)).toContain(
      'lilypad.installed',
    )
  })

  /**
   * Function: pad management routes (authorization)
   * Inputs:   anonymous, a Space owner and an editor calling list, install and uninstall
   * Expected: 401 for anonymous; 403 for non-admins (only the admin brings in new code)
   */
  it('is admin-only', async () => {
    const w = await world()
    for (const [m, p] of [
      ['get', '/api/lilypads'],
      ['post', '/api/lilypads/fixture/install'],
      ['post', '/api/lilypads/fixture/uninstall'],
    ] as const) {
      expect((await new Client(w.env.app).send(m, p, {})).status, `anon ${p}`).toBe(401)
      expect(
        (await w.olga.client.send(m, p, { permissions: [], deleteData: false })).status,
        `owner ${p}`,
      ).toBe(403)
      expect(
        (await w.ann.client.send(m, p, { permissions: [], deleteData: false })).status,
        `editor ${p}`,
      ).toBe(403)
    }
  })

  /**
   * Function: install of an incompatible or unknown pad
   * Inputs:   a pad that needs plugin API ^2.0; a pad id that doesn't exist
   * Expected: 409 "incompatible" for the first (nothing installed); 404 for the second
   */
  it('refuses a pad built for another plugin API and an unknown pad', async () => {
    const w = await world([makeFixturePad({ id: 'future', pondApi: '^2.0' })])
    expect(
      (
        await w.admin.client.post('/api/lilypads/future/install', {
          permissions: manifestPerms(w, 'future'),
        })
      ).body.error,
    ).toBe('incompatible')
    expect(w.env.ctx.repos.pads.installs.list()).toEqual([])
    expect(
      (await w.admin.client.post('/api/lilypads/nope/install', { permissions: [] })).status,
    ).toBe(404)
  })

  /**
   * Function: PadHost.start() after an update that asks for more permissions
   * Inputs:   version 1.0.0 installed with its permissions; Pond restarts with version 1.1.0 that adds
   *           "files:store"; then the admin approves again
   * Expected: after the restart the pad is "needs_approval" and its routes are not served; after re-approval it
   *           runs as version 1.1.0 and "lilypad.updated" is audited
   */
  it('keeps an updated pad off until new permissions are approved', async () => {
    let current = makeFixturePad({ version: '1.0.0', permissions: ['transactions:read'] })
    const w = await world([current])
    w.env.padHost['d'].source = { list: () => [current] }
    await ready(w)
    expect((await w.ann.client.get(url(w.home, 'fixture', '/notes'))).status).toBe(200)

    current = makeFixturePad({
      version: '1.1.0',
      permissions: ['transactions:read', 'files:store'],
    })
    await w.env.padHost.start()
    expect(w.env.padHost.list().find((p) => p.id === 'fixture')).toMatchObject({
      state: 'needs_approval',
      installed: true,
    })
    expect((await w.ann.client.get(url(w.home, 'fixture', '/notes'))).status).toBe(404)

    const re = await w.admin.client.post('/api/lilypads/fixture/install', {
      permissions: ['transactions:read', 'files:store'],
    })
    expect(re.body.pad).toMatchObject({ state: 'running', version: '1.1.0' })
    expect(w.env.ctx.repos.audit.list({ limit: 50 }).map((a) => a.action)).toContain(
      'lilypad.updated',
    )
    expect((await w.ann.client.get(url(w.home, 'fixture', '/notes'))).status).toBe(200)
  })
})

describe('turning a pad on for a Space (owners)', () => {
  /**
   * Function: PUT /api/spaces/:spaceId/pads/:padId/enabled, GET /pads/available, GET /pads
   * Inputs:   an installed pad; a viewer, an editor and the owner trying to enable it; the owner enabling it
   * Expected: 403 for viewer and editor; the owner succeeds; the pad shows as available-and-on for the owner
   *           and as running for a viewer; "lilypad.enabled" is audited with the Space
   */
  it('lets only Space owners switch a pad on', async () => {
    const w = await world()
    expect((await install(w)).status).toBe(200)
    expect(
      (await w.val.client.put(`/api/spaces/${w.home}/pads/fixture/enabled`, { enabled: true }))
        .status,
    ).toBe(403)
    expect(
      (await w.ann.client.put(`/api/spaces/${w.home}/pads/fixture/enabled`, { enabled: true }))
        .status,
    ).toBe(403)
    expect((await w.val.client.get(`/api/spaces/${w.home}/pads`)).body.pads).toEqual([])
    expect((await enable(w, w.home)).status).toBe(200)
    expect(
      (await w.olga.client.get(`/api/spaces/${w.home}/pads/available`)).body.pads[0],
    ).toMatchObject({ id: 'fixture', enabled: true })
    expect(
      (await w.val.client.get(`/api/spaces/${w.home}/pads`)).body.pads.map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual(['fixture'])
    const e = w.env.ctx.repos.audit.list({ limit: 50 }).find((a) => a.action === 'lilypad.enabled')
    expect(e).toMatchObject({ targetId: 'fixture', spaceId: w.home })
  })

  /**
   * Function: enabling a pad for a Space type it doesn't support, or an uninstalled pad
   * Inputs:   a personal-only pad enabled for the business Space; a pad that isn't installed
   * Expected: 400 "space_type_not_supported"; 404; the business Space's available list doesn't offer the pad
   */
  it('refuses unsupported Space types and uninstalled pads', async () => {
    const w = await world([
      makeFixturePad({ spaceTypes: ['personal'] }),
      makeFixturePad({ id: 'other' }),
    ])
    expect((await enable(w, w.home, 'other')).status).toBe(404)
    await install(w)
    expect((await enable(w, w.biz)).body.error).toBe('space_type_not_supported')
    expect((await w.olga.client.get(`/api/spaces/${w.biz}/pads/available`)).body.pads).toEqual([])
    expect((await enable(w, w.home)).status).toBe(200)
  })

  /**
   * Function: pad routes follow enablement
   * Inputs:   a pad route called before enabling, after enabling, and after disabling
   * Expected: 404, 200, 404 (a pad that isn't switched on for a Space has no routes there)
   */
  it("serves a pad's routes only while it is enabled for the Space", async () => {
    const w = await world()
    await install(w)
    const get = () => w.ann.client.get(url(w.home, 'fixture', '/notes'))
    expect((await get()).status).toBe(404)
    await enable(w, w.home)
    expect((await get()).status).toBe(200)
    await enable(w, w.home, 'fixture', false)
    expect((await get()).status).toBe(404)
  })
})

describe('pad routes (same middleware as core)', () => {
  /**
   * Function: pad route authorization (createSpaceRouter)
   * Inputs:   anonymous, a non-member, a viewer and an editor calling a viewer route and an editor route
   * Expected: 401 anonymous; 404 for the non-member (no leak); a viewer may read but gets 403 on the editor
   *           route; an editor may do both
   */
  it('applies sessions, Space membership and roles to every pad route', async () => {
    const w = await world()
    await ready(w)
    expect((await new Client(w.env.app).get(url(w.home, 'fixture', '/notes'))).status).toBe(401)
    expect((await w.outsider.client.get(url(w.home, 'fixture', '/notes'))).status).toBe(404)
    expect((await w.val.client.get(url(w.home, 'fixture', '/notes'))).status).toBe(200)
    expect((await w.val.client.post(url(w.home, 'fixture', '/notes'), { title: 'x' })).status).toBe(
      403,
    )
    expect((await w.ann.client.post(url(w.home, 'fixture', '/notes'), { title: 'x' })).status).toBe(
      200,
    )
  })

  /**
   * Function: pad routes in the permission suite's registry
   * Inputs:   the routes the host mounted for an installed pad
   * Expected: each appears in ctx.spaceRoutes with its minimum role, under /api/spaces/:spaceId/lilypads/<id>/,
   *           so the existing permission suite tests it with no extra code
   */
  it('records every pad route in the shared permission registry', async () => {
    const w = await world()
    await install(w)
    const mine = w.env.ctx.spaceRoutes.filter((r) =>
      r.path.startsWith('/api/spaces/:spaceId/lilypads/fixture/'),
    )
    expect(mine.length).toBeGreaterThan(10)
    expect(mine.find((r) => r.method === 'post' && r.path.endsWith('/notes'))).toMatchObject({
      minRole: 'editor',
    })
    expect(mine.find((r) => r.method === 'get' && r.path.endsWith('/notes'))).toMatchObject({
      minRole: 'viewer',
    })
  })

  /**
   * Function: validation before the handler
   * Inputs:   a body with an empty title; a query value that isn't a number
   * Expected: 400 invalid_input with the failing paths each time; the handler never runs (no note stored)
   */
  it("validates input with the pad's zod schemas before running the handler", async () => {
    const w = await world()
    await ready(w)
    const bad = await w.ann.client.post(url(w.home, 'fixture', '/notes'), { title: '' })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: 'invalid_input', issues: [{ path: 'title' }] })
    expect((await w.ann.client.get(url(w.home, 'fixture', '/items/7?n=abc'))).status).toBe(400)
    expect((await w.ann.client.get(url(w.home, 'fixture', '/notes'))).body.notes).toEqual([])
  })

  /**
   * Function: the request a handler receives
   * Inputs:   GET /whoami and GET /items/42?n=3 as an editor
   * Expected: the handler sees the user, the Space and role, the Space type, and URL params and validated
   *           query (the Space id is not duplicated into params)
   */
  it('gives handlers the user, Space, role, params and validated query', async () => {
    const w = await world()
    await ready(w)
    expect((await w.ann.client.get(url(w.home, 'fixture', '/whoami'))).body).toMatchObject({
      user: 'ann',
      role: 'editor',
      space: w.home,
      type: 'personal',
      params: {},
    })
    expect((await w.ann.client.get(url(w.home, 'fixture', '/items/42?n=3'))).body).toEqual({
      itemId: '42',
      n: 3,
    })
  })

  /**
   * Function: expected errors from a handler (PadError)
   * Inputs:   a handler throwing PadError(404, "no_such_thing")
   * Expected: 404 with that code; it is not counted as a pad failure
   */
  it('turns an expected PadError into its own response', async () => {
    const w = await world()
    await ready(w)
    const r = await w.ann.client.get(url(w.home, 'fixture', '/missing'))
    expect(r).toMatchObject({ status: 404, body: { error: 'no_such_thing' } })
    expect(w.env.padHost['loaded'].get('fixture')!.failures).toBe(0)
  })
})

describe("a pad's own data (table API)", () => {
  /**
   * Function: db.table(name) limits
   * Inputs:   a pad asking for core tables "users" and "splits", another pad's table "notes" of pad "other",
   *           and a table that was never declared
   * Expected: 400 unknown_table each time: only the pad's own declared tables can be reached; nothing from
   *           core leaks
   */
  it('can only reach its own declared tables', async () => {
    const w = await world([makeFixturePad(), makeFixturePad({ id: 'other' })])
    await ready(w)
    await install(w, 'other')
    await enable(w, w.home, 'other')
    await w.ann.client.post(url(w.home, 'other', '/notes'), { title: 'other pad secret' })
    for (const t of ['users', 'splits', 'lp_other_notes', 'sessions', 'nope']) {
      const r = await w.ann.client.get(url(w.home, 'fixture', `/bad-table?t=${t}`))
      expect(r.status, t).toBe(400)
      expect(r.body.error, t).toBe('unknown_table')
    }
    expect((await w.ann.client.get(url(w.home, 'fixture', '/notes'))).body.notes).toEqual([])
  })

  /**
   * Function: automatic Space scoping through HTTP
   * Inputs:   the same pad enabled in two Spaces; notes written in each; a request in one Space
   * Expected: each Space sees only its own notes; a note written in HOME never appears in BIZ
   */
  it("keeps each Space's pad data separate", async () => {
    const w = await world()
    await ready(w)
    await enable(w, w.biz)
    await w.olga.client.post(url(w.home, 'fixture', '/notes'), { title: 'home note' })
    await w.olga.client.post(url(w.biz, 'fixture', '/notes'), { title: 'biz note' })
    expect(
      (await w.olga.client.get(url(w.home, 'fixture', '/notes'))).body.notes.map(
        (n: { title: string }) => n.title,
      ),
    ).toEqual(['home note'])
    expect(
      (await w.olga.client.get(url(w.biz, 'fixture', '/notes'))).body.notes.map(
        (n: { title: string }) => n.title,
      ),
    ).toEqual(['biz note'])
  })

  /**
   * Function: plain-JSON rule for calls across the boundary (strict mode)
   * Inputs:   a handler that passes a Date object into the table API
   * Expected: the call is refused (500 internal_error, counted as a pad failure, no details leaked) and nothing is stored
   */
  it('refuses calls that are not plain JSON', async () => {
    const w = await world()
    await ready(w)
    const r = await w.ann.client.post(url(w.home, 'fixture', '/date-bug'), {})
    expect(r).toMatchObject({ status: 500, body: { error: 'internal_error' } })
    expect(JSON.stringify(r.body)).not.toMatch(/Date|JSON/)
    expect((await w.ann.client.get(url(w.home, 'fixture', '/notes'))).body.notes).toEqual([])
  })
})

describe('core access (the scoped facade)', () => {
  const seed = async (w: World) => {
    const acct = (
      await w.olga.client.post(`/api/spaces/${w.home}/accounts`, {
        name: 'Checking',
        type: 'checking',
        openingBalanceCents: 123456,
      })
    ).body.account.id
    const cats = (await w.olga.client.get(`/api/spaces/${w.home}/categories`)).body.categories
    const groceries = cats.find((c: { name: string }) => c.name === 'Groceries').id
    await w.olga.client.post(`/api/spaces/${w.home}/transactions`, {
      accountId: acct,
      date: '2030-01-10',
      amountCents: -4000,
      description: 'Market',
      splits: [{ spaceId: w.home, amountCents: -4000, categoryId: groceries }],
    })
    await w.olga.client.post(`/api/spaces/${w.home}/transactions`, {
      accountId: acct,
      date: '2030-01-11',
      amountCents: -1000,
      description: 'Coffee',
    })
    return { acct, groceries }
  }

  /**
   * Function: core.transactions / accounts / spaces / balances / splits.sum with permission
   * Inputs:   a pad granted all read permissions, in a Space with an account (balance 1234.56), two transactions
   *           and a categorized split
   * Expected: the pad reads the same data the web app shows: the transactions, the account, the Space, the
   *           latest balance, and split totals by category (-4000 in Groceries, -1000 uncategorized)
   */
  it('lets a pad read core data it was granted', async () => {
    const w = await world()
    await ready(w)
    const { groceries } = await seed(w)
    const tx = (await w.val.client.get(url(w.home, 'fixture', '/core/transactions'))).body
    expect(tx.total).toBe(2)
    expect(tx.transactions.map((t: { descriptionRaw: string }) => t.descriptionRaw).sort()).toEqual(
      ['Coffee', 'Market'],
    )
    expect(
      (await w.val.client.get(url(w.home, 'fixture', '/core/accounts'))).body.accounts[0],
    ).toMatchObject({ name: 'Checking', balanceCents: 123456 })
    expect((await w.val.client.get(url(w.home, 'fixture', '/core/space'))).body).toMatchObject({
      name: 'Home',
      type: 'personal',
    })
    expect(
      (await w.val.client.get(url(w.home, 'fixture', '/core/balances'))).body.balances[0],
    ).toMatchObject({ balanceCents: 123456 })
    const sum = (await w.val.client.get(url(w.home, 'fixture', '/core/sum'))).body.rows
    expect(sum.find((r: { categoryId: string }) => r.categoryId === groceries)).toMatchObject({
      cents: -4000,
      kind: 'expense',
    })
    expect(sum.find((r: { categoryId: string | null }) => r.categoryId === null)).toMatchObject({
      cents: -1000,
    })
  })

  /**
   * Function: permission checks on the facade
   * Inputs:   a pad installed with only "spaces:read"; it calls transactions, accounts, balances and sum, and spaces
   * Expected: 403 pad_permission_denied for the four it wasn't granted; the granted one works
   */
  it('refuses core calls the admin did not approve', async () => {
    const w = await world([makeFixturePad({ permissions: ['spaces:read'] })])
    await ready(w)
    await seed(w)
    for (const p of ['/core/transactions', '/core/accounts', '/core/balances', '/core/sum']) {
      const r = await w.val.client.get(url(w.home, 'fixture', p))
      expect(r, p).toMatchObject({ status: 403, body: { error: 'pad_permission_denied' } })
    }
    expect((await w.val.client.get(url(w.home, 'fixture', '/core/space'))).status).toBe(200)
  })

  /**
   * Function: the facade is bound to one Space
   * Inputs:   the pad enabled in HOME and BIZ; money and an account only in HOME; reads made through BIZ
   * Expected: through BIZ the pad sees no transactions, accounts or sums from HOME (it cannot name another Space)
   */
  it("cannot see another Space's data", async () => {
    const w = await world()
    await ready(w)
    await enable(w, w.biz)
    await seed(w)
    expect((await w.olga.client.get(url(w.biz, 'fixture', '/core/transactions'))).body.total).toBe(
      0,
    )
    expect(
      (await w.olga.client.get(url(w.biz, 'fixture', '/core/accounts'))).body.accounts,
    ).toEqual([])
    expect((await w.olga.client.get(url(w.biz, 'fixture', '/core/sum'))).body.rows).toEqual([])
  })

  /**
   * Function: privacy-filtered views for a pad in another Space
   * Inputs:   a -6000 lunch on HOME's account split -4000 HOME / -2000 BIZ with a private memo; the pad reads
   *           through BIZ, then the transaction is marked private
   * Expected: the pad in BIZ gets the SHARED view (its own -2000 split, no memo, no account id); once private the
   *           account name and total are null, exactly as the web app shows
   */
  it('returns the same privacy-filtered views the web app gets', async () => {
    const w = await world()
    await ready(w)
    await enable(w, w.biz)
    const acct = (
      await w.olga.client.post(`/api/spaces/${w.home}/accounts`, {
        name: 'Visa',
        type: 'credit_card',
      })
    ).body.account.id
    const t = (
      await w.olga.client.post(`/api/spaces/${w.home}/transactions`, {
        accountId: acct,
        date: '2030-01-14',
        amountCents: -6000,
        description: 'Team lunch',
        memo: 'hidden note',
        splits: [
          { spaceId: w.home, amountCents: -4000 },
          { spaceId: w.biz, amountCents: -2000 },
        ],
      })
    ).body.transaction.id
    const shared = (await w.olga.client.get(url(w.biz, 'fixture', '/core/transactions'))).body
      .transactions[0]
    expect(shared).toMatchObject({
      kind: 'shared',
      accountName: 'Visa',
      totalCents: -6000,
      otherSpacesCents: -4000,
    })
    expect(JSON.stringify(shared)).not.toMatch(/hidden note|accountId/)
    await w.olga.client.patch(`/api/spaces/${w.home}/transactions/${t}`, { private: true })
    expect(
      (await w.olga.client.get(url(w.biz, 'fixture', '/core/transactions'))).body.transactions[0],
    ).toMatchObject({ accountName: null, totalCents: null })
  })
})

describe('settings, secrets and audit', () => {
  /**
   * Function: pad settings (manifest-defined, host-stored)
   * Inputs:   read the defaults; the owner sets greeting/limit/mode; a viewer's attempt; a bad integer, bad choice,
   *           unknown key; a pad reading the value
   * Expected: defaults first; the owner's values stored per Space and readable by the pad; viewer 403; each bad value
   *           400; another Space still has defaults
   */
  it('stores validated per-Space settings that pads can read', async () => {
    const w = await world()
    await ready(w)
    await enable(w, w.biz)
    const base = `/api/spaces/${w.home}/pads/fixture/settings`
    const fields = (await w.val.client.get(base)).body.fields
    expect(fields.map((f: { key: string; value: unknown }) => [f.key, f.value])).toEqual([
      ['greeting', 'hello'],
      ['limit', 5],
      ['mode', 'a'],
    ])
    expect((await w.val.client.put(base, { values: { greeting: 'hi' } })).status).toBe(403)
    expect(
      (await w.olga.client.put(base, { values: { greeting: 'hi there', limit: 8, mode: 'b' } }))
        .status,
    ).toBe(200)
    for (const bad of [
      { limit: 99 },
      { limit: 1.5 },
      { mode: 'z' },
      { nope: 1 },
      { adminOnly: true },
    ]) {
      expect((await w.olga.client.put(base, { values: bad })).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await w.ann.client.get(url(w.home, 'fixture', '/setting/greeting'))).body.value).toBe(
      'hi there',
    )
    expect(
      (await w.olga.client.get(`/api/spaces/${w.biz}/pads/fixture/settings`)).body.fields[0].value,
    ).toBe('hello')
  })

  /**
   * Function: global pad settings (admin only) and settings.set from a pad
   * Inputs:   the admin changing a global field; the owner via the Space route; a viewer's request calling
   *           settings.set from inside a pad route
   * Expected: the admin's value is stored; a global field through the Space route is refused (wrong_scope); a pad
   *           handler can't change a setting unless the caller is the Space owner (403)
   */
  it('keeps global settings admin-only and Space settings owner-only', async () => {
    const w = await world()
    await ready(w)
    expect(
      (await w.admin.client.put('/api/lilypads/fixture/settings', { values: { adminOnly: true } }))
        .body.fields[0].value,
    ).toBe(true)
    expect(
      (await w.olga.client.put('/api/lilypads/fixture/settings', { values: { adminOnly: false } }))
        .status,
    ).toBe(403)
    expect(
      (
        await w.olga.client.put(`/api/spaces/${w.home}/pads/fixture/settings`, {
          values: { adminOnly: false },
        })
      ).body.error,
    ).toBe('wrong_scope')
    expect(
      (await w.val.client.put(url(w.home, 'fixture', '/setting/greeting'), { value: 'x' })).status,
    ).toBe(403)
    expect(
      (await w.olga.client.put(url(w.home, 'fixture', '/setting/greeting'), { value: 'from pad' }))
        .status,
    ).toBe(200)
    expect((await w.val.client.get(url(w.home, 'fixture', '/setting/greeting'))).body.value).toBe(
      'from pad',
    )
  })

  /**
   * Function: ctx.secrets and ctx.audit
   * Inputs:   a pad with "secrets:use" encrypting and decrypting text, and one without it; a pad audit entry whose
   *           meta contains a "password" key
   * Expected: the round trip works and the stored form is encrypted ("v1:"); without the permission 403; the audit
   *           entry is attributed to the pad ("lilypad.fixture.did_thing", actor type lilypad, Space id) and the
   *           password value is redacted
   */
  it('offers encryption only with its permission and audits as the pad', async () => {
    const w = await world([
      makeFixturePad(),
      makeFixturePad({ id: 'nokey', permissions: ['spaces:read'] }),
    ])
    await ready(w)
    await install(w, 'nokey')
    await enable(w, w.home, 'nokey')
    const r = await w.ann.client.post(url(w.home, 'fixture', '/secret'), { text: '123-45-6789' })
    expect(r.body.enc).toMatch(/^v1:/)
    expect(r.body.enc).not.toContain('123-45-6789')
    expect(r.body.dec).toBe('123-45-6789')
    expect((await w.ann.client.post(url(w.home, 'nokey', '/secret'), { text: 'x' })).status).toBe(
      403,
    )

    await w.ann.client.post(url(w.home, 'fixture', '/audit'), {})
    const e = w.env.ctx.repos.audit
      .list({ limit: 100 })
      .find((a) => a.action === 'lilypad.fixture.did_thing')!
    expect(e).toMatchObject({
      actorType: 'lilypad',
      actorId: 'fixture',
      spaceId: w.home,
      targetType: 'thing',
      targetId: 't1',
    })
    expect(e.meta).toEqual({ count: 2, password: '[redacted]' })
  })
})

describe('failure isolation', () => {
  /**
   * Function: a pad that throws while starting
   * Inputs:   two pads, one whose register() throws; both installed
   * Expected: the broken pad shows state "error" with a reason; the other pad runs normally; Pond itself is unaffected
   */
  it('keeps a broken pad from affecting others', async () => {
    const w = await world([
      makeFixturePad({ id: 'broken', failRegister: true }),
      makeFixturePad({ id: 'fine' }),
    ])
    await install(w, 'broken')
    await install(w, 'fine')
    const list = w.env.padHost.list()
    expect(list.find((p) => p.id === 'broken')).toMatchObject({ state: 'error', installed: true })
    expect(list.find((p) => p.id === 'broken')!.problem).toContain('register exploded')
    expect(list.find((p) => p.id === 'fine')!.state).toBe('running')
    expect(
      (await w.olga.client.put(`/api/spaces/${w.home}/pads/broken/enabled`, { enabled: true }))
        .status,
    ).toBe(404)
    expect((await enable(w, w.home, 'fine')).status).toBe(200)
    expect((await w.ann.client.get(url(w.home, 'fine', '/notes'))).status).toBe(200)
  })

  /**
   * Function: a handler that throws an unexpected error
   * Inputs:   the /boom route called until the failure limit (3 here)
   * Expected: each call is a plain 500 with no message or stack; after the limit the pad answers 503
   *           pad_unavailable, "lilypad.auto_disabled" is audited, and the rest of Pond still works
   */
  it('returns a plain 500 for pad bugs and switches the pad off after repeated ones', async () => {
    const w = await world([makeFixturePad()], 3)
    await ready(w)
    for (let i = 0; i < 3; i++) {
      const r = await w.ann.client.get(url(w.home, 'fixture', '/boom'))
      expect(r.status).toBe(500)
      expect(JSON.stringify(r.body)).not.toContain('secret internal detail')
    }
    expect((await w.ann.client.get(url(w.home, 'fixture', '/notes'))).body).toEqual({
      error: 'pad_unavailable',
    })
    expect(w.env.ctx.repos.audit.list({ limit: 50 }).map((a) => a.action)).toContain(
      'lilypad.auto_disabled',
    )
    expect((await w.ann.client.get(`/api/spaces/${w.home}/transactions`)).status).toBe(200)
    expect(w.env.padHost.listForSpace(w.home)).toEqual([])
  })

  /**
   * Function: pad route declarations the host refuses
   * Inputs:   pads that declare a route with no role, a route under the reserved "_host" path, and a route twice
   * Expected: each pad ends in state "error" with a reason (the mistake is caught at start-up, not in production use)
   */
  it('refuses badly declared routes at start-up', async () => {
    const { definePad, defineMigration, definePadModule } = await import('@pond/sdk')
    const mod = (id: string, register: Parameters<typeof definePad>[0]['register']) => {
      const base = makeFixturePad({ id })
      return definePadModule({
        manifest: base.manifest,
        migrations: [defineMigration('0001', () => {})],
        server: definePad({ register }),
      })
    }
    const w = await world([
      mod('norole', (ctx) => ctx.router.get('/x', {} as never, async () => ({}))),
      mod('reserved', (ctx) => ctx.router.get('/_host/x', { role: 'viewer' }, async () => ({}))),
      mod('twice', (ctx) => {
        ctx.router.get('/x', { role: 'viewer' }, async () => ({}))
        ctx.router.get('/x', { role: 'viewer' }, async () => ({}))
      }),
    ])
    for (const id of ['norole', 'reserved', 'twice']) await install(w, id)
    for (const p of w.env.padHost.list()) expect(p.state, p.id).toBe('error')
  })
})

describe('events from core', () => {
  /**
   * Function: transaction.created and space.created reaching a pad
   * Inputs:   the pad enabled in HOME only; a transaction created in HOME; one in BIZ (pad not enabled there); a new Space
   * Expected: the pad's handler ran once for HOME, as the Space itself (no user, no role), and wrote to its own table;
   *           nothing for BIZ; a "space.created" event for the new Space is not delivered (pad not enabled there)
   */
  it('delivers events only for Spaces where the pad is enabled, without a user', async () => {
    const log: NonNullable<FixtureOptions['log']> = { events: [], jobs: [] }
    const w = await world([makeFixturePad({ log })])
    await ready(w)
    const a1 = (
      await w.olga.client.post(`/api/spaces/${w.home}/accounts`, { name: 'A', type: 'checking' })
    ).body.account.id
    const a2 = (
      await w.olga.client.post(`/api/spaces/${w.biz}/accounts`, { name: 'B', type: 'checking' })
    ).body.account.id
    const t = (
      await w.olga.client.post(`/api/spaces/${w.home}/transactions`, {
        accountId: a1,
        date: '2030-01-10',
        amountCents: -100,
        description: 'x',
      })
    ).body.transaction.id
    await w.olga.client.post(`/api/spaces/${w.biz}/transactions`, {
      accountId: a2,
      date: '2030-01-10',
      amountCents: -100,
      description: 'y',
    })
    await w.admin.client.post('/api/spaces', { name: 'New', type: 'personal' })
    await w.env.events.whenIdle()
    expect(log.events).toEqual([
      { type: 'transaction.created', spaceId: w.home, userId: null, role: null },
    ])
    expect(
      (await w.olga.client.get(url(w.home, 'fixture', '/notes'))).body.notes.map(
        (n: { title: string }) => n.title,
      ),
    ).toEqual([`event ${t}`])
  })

  /**
   * Function: events for a transaction split across Spaces
   * Inputs:   the pad enabled in HOME and BIZ; a transaction on HOME's account with splits in both
   * Expected: one transaction.created event per Space the transaction touches (so a pad in BIZ hears about its share)
   */
  it('announces a cross-Space transaction to every Space it touches', async () => {
    const log: NonNullable<FixtureOptions['log']> = { events: [], jobs: [] }
    const w = await world([makeFixturePad({ log })])
    await ready(w)
    await enable(w, w.biz)
    const acct = (
      await w.olga.client.post(`/api/spaces/${w.home}/accounts`, { name: 'A', type: 'checking' })
    ).body.account.id
    await w.olga.client.post(`/api/spaces/${w.home}/transactions`, {
      accountId: acct,
      date: '2030-01-10',
      amountCents: -300,
      description: 'z',
      splits: [
        { spaceId: w.home, amountCents: -200 },
        { spaceId: w.biz, amountCents: -100 },
      ],
    })
    await w.env.events.whenIdle()
    expect(log.events.map((e) => e.spaceId).sort()).toEqual([w.biz, w.home].sort())
  })

  /**
   * Function: a failing event handler
   * Inputs:   a pad whose transaction.created handler throws, and a healthy pad; a transaction is created
   * Expected: the transaction is created normally (201); the healthy pad still received its event; the failure is
   *           counted against the failing pad only
   */
  it('never lets a failing handler affect core or other pads', async () => {
    const goodLog: NonNullable<FixtureOptions['log']> = { events: [], jobs: [] }
    const w = await world([
      makeFixturePad({ id: 'bad', failEvents: true }),
      makeFixturePad({ id: 'good', log: goodLog }),
    ])
    for (const id of ['bad', 'good']) {
      await install(w, id)
      await enable(w, w.home, id)
    }
    const acct = (
      await w.olga.client.post(`/api/spaces/${w.home}/accounts`, { name: 'A', type: 'checking' })
    ).body.account.id
    const r = await w.olga.client.post(`/api/spaces/${w.home}/transactions`, {
      accountId: acct,
      date: '2030-01-10',
      amountCents: -100,
      description: 'x',
    })
    expect(r.status).toBe(201)
    await w.env.events.whenIdle()
    expect(goodLog.events).toHaveLength(1)
    expect(w.env.padHost['loaded'].get('bad')!.failures).toBe(1)
    expect(w.env.padHost['loaded'].get('good')!.failures).toBe(0)
  })
})

describe('scheduled jobs', () => {
  const DAY = 86_400_000

  /**
   * Function: PadHost.runDueJobs() with a monthly job (day 1, 06:00)
   * Inputs:   the pad enabled in HOME on Jan 15; checks right away, on Feb 1 at 07:00, again on Feb 1 at 08:00, in
   *           mid-February, and on Mar 1 at 07:00
   * Expected: nothing on the first check (it only starts the clock); runs once on Feb 1; not again until Mar 1;
   *           each run is scoped to HOME
   */
  it('starts the clock on first sight, then runs once per occurrence', async () => {
    const log: NonNullable<FixtureOptions['log']> = { events: [], jobs: [] }
    const w = await world([makeFixturePad({ log })])
    await ready(w) // clock: 2026-01-01T12:00Z in the harness
    const host = w.env.padHost
    expect(await host.runDueJobs()).toBe(0)
    w.env.advance(31 * DAY + 19 * 3_600_000) // 2026-02-01T07:00Z
    expect(await host.runDueJobs()).toBe(1)
    w.env.advance(3_600_000)
    expect(await host.runDueJobs()).toBe(0)
    w.env.advance(14 * DAY)
    expect(await host.runDueJobs()).toBe(0)
    w.env.advance(14 * DAY) // 2026-03-01T08:00Z
    expect(await host.runDueJobs()).toBe(1)
    expect(log.jobs).toEqual([{ spaceId: w.home }, { spaceId: w.home }])
  })

  /**
   * Function: catching up after downtime, and skipping Spaces where the pad is off
   * Inputs:   six months pass with no checks (Pond was off); the pad is also enabled in BIZ and then disabled
   * Expected: one catch-up run per enabled Space (not one per missed month); nothing for a Space where the pad is off
   */
  it('catches up once after downtime and skips Spaces where the pad is off', async () => {
    const log: NonNullable<FixtureOptions['log']> = { events: [], jobs: [] }
    const w = await world([makeFixturePad({ log })])
    await ready(w)
    await enable(w, w.biz)
    await w.env.padHost.runDueJobs() // start the clocks
    await enable(w, w.biz, 'fixture', false)
    w.env.advance(180 * DAY)
    expect(await w.env.padHost.runDueJobs()).toBe(1)
    expect(log.jobs).toEqual([{ spaceId: w.home }])
  })
})

describe('uninstalling', () => {
  /**
   * Function: POST /api/lilypads/:padId/uninstall (keep data)
   * Inputs:   a running pad with a note and a Space setting; uninstalled keeping data; its route called; then reinstalled
   *           and re-enabled
   * Expected: after uninstall the pad's routes answer 404 and the Space switch is gone; its table and note remain, so
   *           after reinstalling the note is still there (migrations aren't repeated)
   */
  it("can keep a pad's data for a later reinstall", async () => {
    const w = await world()
    await ready(w)
    await w.ann.client.post(url(w.home, 'fixture', '/notes'), { title: 'keep me' })
    expect(
      (await w.admin.client.post('/api/lilypads/fixture/uninstall', { deleteData: false })).status,
    ).toBe(200)
    expect((await w.ann.client.get(url(w.home, 'fixture', '/notes'))).status).toBe(404)
    expect(w.env.ctx.repos.pads.enablement.padsForSpace(w.home)).toEqual([])
    expect(w.env.ctx.repos.pads.migrations.applied('fixture')).toEqual(['0001_init'])
    await ready(w)
    expect(
      (await w.ann.client.get(url(w.home, 'fixture', '/notes'))).body.notes.map(
        (n: { title: string }) => n.title,
      ),
    ).toEqual(['keep me'])
  })

  /**
   * Function: uninstall with "delete data"
   * Inputs:   a pad with a note and a saved setting, uninstalled with deleteData = true, then reinstalled
   * Expected: its migration records and settings are removed; after reinstalling the pad starts fresh (no notes, default
   *           settings); "lilypad.uninstalled" is audited with deletedData = true
   */
  it("can delete a pad's data completely", async () => {
    const w = await world()
    await ready(w)
    await w.ann.client.post(url(w.home, 'fixture', '/notes'), { title: 'gone soon' })
    await w.olga.client.put(`/api/spaces/${w.home}/pads/fixture/settings`, {
      values: { greeting: 'custom' },
    })
    await w.admin.client.post('/api/lilypads/fixture/uninstall', { deleteData: true })
    expect(w.env.ctx.repos.pads.migrations.applied('fixture')).toEqual([])
    expect(w.env.ctx.repos.settings.get('space', w.home, 'lp.fixture.greeting')).toBeUndefined()
    expect(
      w.env.ctx.repos.audit.list({ limit: 50 }).find((a) => a.action === 'lilypad.uninstalled')!
        .meta,
    ).toMatchObject({ deletedData: true })
    await ready(w)
    expect((await w.ann.client.get(url(w.home, 'fixture', '/notes'))).body.notes).toEqual([])
    expect((await w.ann.client.get(url(w.home, 'fixture', '/setting/greeting'))).body.value).toBe(
      'hello',
    )
  })
})

describe('PadHost safety copy before migrations (deps.beforeMigrate)', () => {
  /**
   * Function: PadHost.install when beforeMigrate fails, then works
   * Inputs:   a safety-copy hook that throws once, installing the fixture pad twice
   * Expected: the first install leaves the pad in "error" with none of its migrations applied;
   *           the second applies them. Pond never changes the database unprotected.
   */
  it('does not migrate unless the safety copy was made', async () => {
    const w = await world()
    let fail = true
    w.env.padHost['d'].beforeMigrate = async () => {
      if (fail) throw new Error('Pond could not make a safety copy')
    }
    const first = await install(w)
    expect(first.body.pad.state).toBe('error')
    expect(first.body.pad.problem).toContain('safety copy')
    expect(w.env.ctx.repos.pads.migrations.applied('fixture')).toEqual([])
    fail = false
    const second = await install(w)
    expect(second.body.pad.state).toBe('running')
    expect(w.env.ctx.repos.pads.migrations.applied('fixture').length).toBeGreaterThan(0)
  })
})
