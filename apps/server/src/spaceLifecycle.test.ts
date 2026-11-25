import { describe, expect, it } from 'vitest'
import { makeFixturePad, type FixtureOptions } from './testing/fixturePad'
import { Client, bootstrapAdmin, createUser, makeEnv, type Account } from './testing/harness'

/**
 * Archiving, restoring and deleting Spaces over HTTP: the real app on in-memory fakes, with the
 * test "fixture" LilyPad switched on to prove apps sleep too.
 *
 * Mock data: "admin"; "olga" owns Spaces WORK (business) and SPARE (personal); "val" views WORK.
 */
async function world() {
  const log: NonNullable<FixtureOptions['log']> = { events: [], jobs: [] }
  const env = makeEnv({ pads: [makeFixturePad({ log })] })
  const admin = await bootstrapAdmin(env)
  const olga = await createUser(env, admin, 'olga', '10.4.0.1')
  const val = await createUser(env, admin, 'val', '10.4.0.2')
  const space = async (name: string, type: string) =>
    (await admin.client.post('/api/spaces', { name, type, ownerUserId: olga.id })).body.space
      .id as string
  const work = await space('Work', 'business')
  const spare = await space('Spare', 'personal')
  await olga.client.put(`/api/spaces/${work}/members/${val.id}`, { role: 'viewer' })
  const permissions = env.padHost
    .list()
    .find((p) => p.id === 'fixture')!
    .permissions.map((p) => p.permission)
  await admin.client.post('/api/lilypads/fixture/install', { permissions })
  await olga.client.put(`/api/spaces/${work}/pads/fixture/enabled`, { enabled: true })
  const names = async (who: Account) =>
    (await who.client.get('/api/spaces')).body.spaces.map((s: { name: string }) => s.name)
  return { env, admin, olga, val, work, spare, names, log }
}
const actions = (w: Awaited<ReturnType<typeof world>>) =>
  w.env.ctx.repos.audit.list({ limit: 100 }).map((a) => a.action)

describe('who may archive, restore and delete', () => {
  /**
   * Function: POST .../archive, POST .../restore, DELETE /api/spaces/:id, GET /api/spaces/archived
   * Inputs:   a signed-out caller; the Space's owner; the old way, PATCH with {archived: true}
   * Expected: 401 signed out; 403 for the owner on all four; PATCH can't archive (400); the Space
   *           is untouched
   */
  it('is the administrator alone', async () => {
    const w = await world()
    const calls = [
      ['post', `/api/spaces/${w.work}/archive`],
      ['post', `/api/spaces/${w.work}/restore`],
      ['delete', `/api/spaces/${w.work}`],
      ['get', '/api/spaces/archived'],
    ] as const
    for (const [method, path] of calls) {
      expect((await new Client(w.env.app).send(method, path, {})).status, path).toBe(401)
      expect((await w.olga.client.send(method, path, {})).status, path).toBe(403)
    }
    expect((await w.olga.client.patch(`/api/spaces/${w.work}`, { archived: true })).status).toBe(
      400,
    )
    expect(w.env.ctx.repos.spaces.findById(w.work)!.archivedAt).toBeNull()
  })
})

describe('an archived Space', () => {
  /**
   * Function: POST .../archive and what follows
   * Inputs:   the administrator archives WORK; the admin, owner and viewer then list Spaces and
   *           call a core route, a members route, an app route and the rename route
   * Expected: it leaves everyone's list and shows only in the archived list; every Space route is
   *           404 for all three, administrator included; it is audited
   */
  it('is closed to everyone and gone from their lists', async () => {
    const w = await world()
    expect((await w.admin.client.post(`/api/spaces/${w.work}/archive`)).status).toBe(200)
    expect(await w.names(w.admin)).toEqual(['Spare'])
    expect(await w.names(w.olga)).toEqual(['Spare'])
    expect(await w.names(w.val)).toEqual([])
    expect(
      (await w.admin.client.get('/api/spaces/archived')).body.spaces.map(
        (s: { name: string }) => s.name,
      ),
    ).toEqual(['Work'])
    const base = `/api/spaces/${w.work}`
    for (const who of [w.admin, w.olga, w.val]) {
      for (const path of ['', '/accounts', '/members', '/transactions', '/lilypads/fixture/notes'])
        expect((await who.client.get(base + path)).status, `${who.username} ${path}`).toBe(404)
      expect((await who.client.patch(base, { name: 'x' })).status).toBe(404)
    }
    expect(actions(w)).toContain('space.archived')
  })

  /**
   * Function: LilyPads while a Space is archived
   * Inputs:   an event and a due job for the archived Space; the admin's app list
   * Expected: the pad hears no event and runs no job for it, and doesn't count it as "on"; after
   *           restoring, events arrive again
   */
  it('puts its apps to sleep', async () => {
    const w = await world()
    const event = async () => {
      w.env.events.emit({ type: 'transaction.created', spaceId: w.work, transactionId: 't' })
      await w.env.events.whenIdle()
    }
    await w.env.padHost.runDueJobs() // starts each job's clock
    await w.admin.client.post(`/api/spaces/${w.work}/archive`)
    await event()
    w.env.advance(40 * 24 * 3_600_000)
    await w.env.padHost.runDueJobs()
    expect(w.log).toEqual({ events: [], jobs: [] })
    expect(w.env.padHost.isEnabled('fixture', w.work)).toBe(false)
    expect(w.env.padHost.list().find((p) => p.id === 'fixture')!.enabledSpaceIds).toEqual([])
    w.env.ctx.repos.spaces.update(w.work, { archivedAt: null })
    await event()
    expect(w.log.events).toHaveLength(1)
  })

  /**
   * Function: POST .../restore
   * Inputs:   archive then restore WORK, which has a member, an app switched on and a bank account
   *           on a connection that last synced yesterday
   * Expected: back in everyone's list with the same members and apps; the connection's last-sync
   *           time is cleared so it looks back again; audited
   */
  it('comes back as it was, and its bank connection looks back again', async () => {
    const w = await world()
    const repos = w.env.ctx.repos
    repos.connections.create({
      id: 'conn',
      label: 'Bank',
      accessUrlEnc: 'v1:x',
      createdBy: w.admin.id,
    })
    repos.connections.update('conn', { lastSyncedAt: '2025-12-31T00:00:00.000Z' })
    repos.accounts.create({
      id: 'bank-account',
      name: 'Checking',
      type: 'checking',
      currency: 'USD',
      primarySpaceId: w.work,
      connectionId: 'conn',
      externalId: 'E1',
      isManual: false,
    })
    await w.admin.client.post(`/api/spaces/${w.work}/archive`)
    expect((await w.admin.client.post(`/api/spaces/${w.work}/restore`)).status).toBe(200)
    expect(await w.names(w.val)).toEqual(['Work'])
    expect((await w.val.client.get(`/api/spaces/${w.work}/accounts`)).status).toBe(200)
    expect(w.env.padHost.isEnabled('fixture', w.work)).toBe(true)
    expect(repos.connections.findById('conn')!.lastSyncedAt).toBeNull()
    expect(actions(w)).toContain('space.restored')
  })
})

describe('deleting a Space', () => {
  /**
   * Function: DELETE /api/spaces/:spaceId
   * Inputs:   SPARE, which only has its starting categories and a member
   * Expected: 200; gone from every list, 404 afterwards; audited; the other Space is untouched
   */
  it('removes an empty one for good', async () => {
    const w = await world()
    expect((await w.admin.client.delete(`/api/spaces/${w.spare}`)).status).toBe(200)
    expect(await w.names(w.olga)).toEqual(['Work'])
    expect(w.env.ctx.repos.spaces.findById(w.spare)).toBeUndefined()
    expect((await w.admin.client.delete(`/api/spaces/${w.spare}`)).status).toBe(404)
    expect(actions(w)).toContain('space.deleted')
  })

  /**
   * Function: DELETE /api/spaces/:spaceId (something to lose)
   * Inputs:   WORK given an account; then, in SPARE, a LilyPad row kept after the app is removed
   * Expected: 409 space_not_empty with the counts, both times, and nothing removed
   */
  it('refuses one that holds anything, including data an app left behind', async () => {
    const w = await world()
    await w.olga.client.post(`/api/spaces/${w.work}/accounts`, { name: 'Till', type: 'cash' })
    const first = await w.admin.client.delete(`/api/spaces/${w.work}`)
    expect([first.status, first.body.error, first.body.contents.accounts]).toEqual([
      409,
      'space_not_empty',
      1,
    ])
    await w.olga.client.put(`/api/spaces/${w.spare}/pads/fixture/enabled`, { enabled: true })
    const made = await w.olga.client.post(`/api/spaces/${w.spare}/lilypads/fixture/notes`, {
      title: 'keep me',
    })
    expect(made.status).toBe(200)
    await w.admin.client.post('/api/lilypads/fixture/uninstall', { deleteData: false })
    const second = await w.admin.client.delete(`/api/spaces/${w.spare}`)
    expect(second.body).toMatchObject({ error: 'space_not_empty', contents: { appRows: 1 } })
    expect(await w.names(w.olga)).toEqual(['Spare', 'Work'])
  })
})
