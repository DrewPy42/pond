import { describe, expect, it } from 'vitest'
import { SimpleFinError } from '../simplefin/types'
import { sfAccount, sfTxn } from '../testing/fakeSimpleFin'
import { Client, bootstrapAdmin, createUser, makeEnv } from '../testing/harness'
import { TOKEN } from '../testing/syncWorld'

/**
 * HTTP-level tests of /api/connections (admin-only SimpleFIN connections). The real app runs on
 * in-memory fakes with a scripted FakeSimpleFin as the "bank"; requests carry sessions and CSRF
 * like a browser's. Business rules are covered in sync/service.test.ts; this checks the wiring,
 * validation, authorization, and that secrets never leave the server.
 */

const connect = (c: Client, body: object = { setupToken: TOKEN, label: 'My bank' }) =>
  c.post('/api/connections', body)

describe('/api/connections authorization', () => {
  /**
   * Function: requireAuth + requireAdmin on every connections route
   * Inputs:   anonymous, and a signed-in non-admin, calling each route
   * Expected: 401 for anonymous; 403 for the non-admin, on every route (a bank link is household-wide)
   */
  it('is admin-only on every route', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const user = await createUser(env, admin, 'val')
    const routes: ['get' | 'post' | 'patch' | 'delete', string][] = [
      ['get', '/api/connections'],
      ['post', '/api/connections'],
      ['post', '/api/connections/x/sync'],
      ['post', '/api/connections/x/discover'],
      ['patch', '/api/connections/x/accounts/y'],
      ['delete', '/api/connections/x'],
    ]
    for (const [m, p] of routes) {
      expect((await new Client(env.app).send(m, p, {})).status, `anon ${m} ${p}`).toBe(401)
      expect((await user.client.send(m, p, {})).status, `user ${m} ${p}`).toBe(403)
    }
  })
})

describe('POST /api/connections (connect a bank)', () => {
  /**
   * Function: POST /api/connections, GET /api/connections
   * Inputs:   a valid token and label while the bank reports one account
   * Expected: 201 with the connection and its discovered (unassigned, hidden) account; the Access
   *           URL, its password and the token appear nowhere in either response; the list shows it
   */
  it('connects, discovers accounts, and never returns the Access URL', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    env.simplefin.returns([sfAccount({ id: 'ACT-1', name: 'Everyday Checking' })])
    const res = await connect(admin.client)
    expect(res.status).toBe(201)
    expect(res.body.connection).toMatchObject({ label: 'My bank', status: 'active' })
    expect(res.body.connection.accounts[0]).toMatchObject({
      name: 'Everyday Checking',
      primarySpaceId: null,
      hidden: true,
    })
    const list = await admin.client.get('/api/connections')
    expect(list.body.connections).toHaveLength(1)
    for (const body of [res.body, list.body]) {
      expect(JSON.stringify(body)).not.toMatch(/secret-pass|simplefin\.test|accessUrl/)
      expect(JSON.stringify(body)).not.toContain(TOKEN)
    }
  })

  /**
   * Function: POST /api/connections validation and failure mapping
   * Inputs:   a too-short token; an empty label; then a bank that rejects the token (403)
   * Expected: 400 invalid_input twice; 400 "token_rejected" with a human message; nothing stored
   */
  it('validates input and reports a rejected token clearly', async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    expect((await connect(admin.client, { setupToken: 'abc', label: 'x' })).status).toBe(400)
    expect((await connect(admin.client, { setupToken: TOKEN, label: '  ' })).status).toBe(400)
    env.simplefin.rejectClaim(new SimpleFinError('token_rejected', 'SimpleFIN rejected the token.'))
    const res = await connect(admin.client)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({
      error: 'token_rejected',
      message: 'SimpleFIN rejected the token.',
    })
    expect((await admin.client.get('/api/connections')).body.connections).toEqual([])
  })
})

describe('assign, sync and revoke over HTTP', () => {
  const setup = async () => {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    env.simplefin.returns([sfAccount({ id: 'ACT-1', name: 'Everyday Checking' })])
    const conn = (await connect(admin.client)).body.connection
    const space = (await admin.client.post('/api/spaces', { name: 'Home', type: 'personal' })).body
      .space.id
    return { env, admin, conn, space, accountId: conn.accounts[0].id as string }
  }

  /**
   * Function: PATCH /api/connections/:id/accounts/:accountId, POST .../sync, then GET the Space's
   *           transactions
   * Inputs:   assign the account to a Space, then sync a bank reporting one transaction
   * Expected: the account is assigned with syncing on; the sync returns a summary (1 inserted); the
   *           transaction then shows in that Space's transaction list with its single split
   */
  it('assigns a Space, syncs, and the transactions appear in that Space', async () => {
    const { env, admin, conn, space, accountId } = await setup()
    const a = await admin.client.patch(`/api/connections/${conn.id}/accounts/${accountId}`, {
      primarySpaceId: space,
    })
    expect(a.body.account).toMatchObject({
      primarySpaceId: space,
      syncEnabled: true,
      hidden: false,
    })
    env.simplefin.returns([
      sfAccount({
        id: 'ACT-1',
        name: 'Everyday Checking',
        transactions: [sfTxn({ id: 'T1', amountCents: -4200, description: 'COFFEE' })],
      }),
    ])
    const s = await admin.client.post(`/api/connections/${conn.id}/sync`)
    expect(s.status).toBe(200)
    expect(s.body.summary).toMatchObject({ ok: true, inserted: 1 })
    const list = await admin.client.get(`/api/spaces/${space}/transactions`)
    expect(list.body.transactions[0]).toMatchObject({
      descriptionRaw: 'COFFEE',
      amountCents: -4200,
      kind: 'full',
    })
    expect(list.body.transactions[0].splits).toHaveLength(1)
  })

  /**
   * Function: POST .../sync twice in a row
   * Inputs:   two manual syncs back to back
   * Expected: the second gets 429 "sync_too_soon" with a retry time (protects the bank allowance)
   */
  it('throttles back-to-back manual syncs', async () => {
    const { admin, conn, space, accountId } = await setup()
    await admin.client.patch(`/api/connections/${conn.id}/accounts/${accountId}`, {
      primarySpaceId: space,
    })
    expect((await admin.client.post(`/api/connections/${conn.id}/sync`)).status).toBe(200)
    const again = await admin.client.post(`/api/connections/${conn.id}/sync`)
    expect(again.status).toBe(429)
    expect(again.body).toMatchObject({ error: 'sync_too_soon' })
    expect(again.body.retryAfterSeconds).toBeGreaterThan(0)
  })

  /**
   * Function: POST .../sync against a failing bank
   * Inputs:   the bank answers auth_failed
   * Expected: 200 with summary.ok = false and the message; the connection shows status "error"
   *           and lastError so the UI can say what to do
   */
  it('reports a failed sync in the response and on the connection', async () => {
    const { env, admin, conn, space, accountId } = await setup()
    await admin.client.patch(`/api/connections/${conn.id}/accounts/${accountId}`, {
      primarySpaceId: space,
    })
    env.simplefin.fail(new SimpleFinError('auth_failed', 'Access was revoked; connect again.'))
    const s = await admin.client.post(`/api/connections/${conn.id}/sync`)
    expect(s.body.summary).toMatchObject({ ok: false, error: 'Access was revoked; connect again.' })
    expect(s.body.connection).toMatchObject({
      status: 'error',
      lastError: 'Access was revoked; connect again.',
    })
  })

  /**
   * Function: DELETE /api/connections/:id
   * Inputs:   revoke a connection, then try to sync it and look at the list
   * Expected: ok; the connection shows status "revoked"; syncing it gives 409 "revoked"
   */
  it('revokes a connection', async () => {
    const { admin, conn } = await setup()
    expect((await admin.client.delete(`/api/connections/${conn.id}`)).status).toBe(200)
    expect((await admin.client.get('/api/connections')).body.connections[0]).toMatchObject({
      status: 'revoked',
    })
    expect((await admin.client.post(`/api/connections/${conn.id}/sync`)).status).toBe(409)
  })

  /**
   * Function: POST /api/spaces/:spaceId/transactions on a bank-fed account
   * Inputs:   an editor typing a transaction onto a synced account
   * Expected: 409 "synced_account" (those transactions come from the bank)
   */
  it('stops hand-typed transactions on a bank-fed account', async () => {
    const { admin, conn, space, accountId } = await setup()
    await admin.client.patch(`/api/connections/${conn.id}/accounts/${accountId}`, {
      primarySpaceId: space,
    })
    const res = await admin.client.post(`/api/spaces/${space}/transactions`, {
      accountId,
      date: '2030-01-10',
      amountCents: -100,
      description: 'x',
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('synced_account')
  })
})
