import { describe, expect, it } from 'vitest'
import { bootstrapAdmin, createUser, makeEnv, type Account, type TestEnv } from '../testing/harness'

/**
 * HTTP-level tests of the ledger routes (/api/spaces/:spaceId/...). The real app runs on
 * in-memory fake repositories; requests go through sessions, CSRF, zod validation and the Space
 * permission middleware like a browser's would. Business rules themselves are tested in
 * service.test.ts; here we check the wiring, validation and response shapes.
 *
 * Mock data: "admin" (site admin), "val" (viewer of Space HOME), a personal Space HOME and a
 * business Space BIZ.
 */

interface World {
  env: TestEnv
  admin: Account
  val: Account
  home: string
  biz: string
}

async function world(): Promise<World> {
  const env = makeEnv()
  const admin = await bootstrapAdmin(env)
  const val = await createUser(env, admin, 'val')
  const home = (await admin.client.post('/api/spaces', { name: 'Home', type: 'personal' })).body
    .space.id
  const biz = (await admin.client.post('/api/spaces', { name: 'Biz', type: 'business' })).body.space
    .id
  await admin.client.put(`/api/spaces/${home}/members/${val.id}`, { role: 'viewer' })
  return { env, admin, val, home, biz }
}

const addAccount = async (w: World, space: string, body: object = {}) =>
  (
    await w.admin.client.post(`/api/spaces/${space}/accounts`, {
      name: 'Checking',
      type: 'checking',
      ...body,
    })
  ).body.account

const addTxn = (w: World, space: string, body: object) =>
  w.admin.client.post(`/api/spaces/${space}/transactions`, {
    date: '2030-01-10',
    description: 'Thing',
    ...body,
  })

describe('POST /api/spaces (category seeding)', () => {
  /**
   * Function: POST /api/spaces, GET /api/spaces/:spaceId/categories
   * Inputs:   a new personal Space and a new business Space
   * Expected: the personal one has "Groceries" and the business one "Advertising", both with
   *           no tax line
   */
  it('seeds starter categories by Space type', async () => {
    const w = await world()
    const home = (await w.admin.client.get(`/api/spaces/${w.home}/categories`)).body.categories
    const biz = (await w.admin.client.get(`/api/spaces/${w.biz}/categories`)).body.categories
    expect(home.find((c: { name: string }) => c.name === 'Groceries')).toMatchObject({
      kind: 'expense',
      taxLine: null,
    })
    expect(biz.find((c: { name: string }) => c.name === 'Advertising')).toMatchObject({
      taxLine: null,
    })
  })
})

describe('accounts and balances routes', () => {
  /**
   * Function: POST /accounts, GET /accounts, PUT /accounts/:id/balances/:date, GET .../balances
   * Inputs:   a checking account with opening balance 125000, then a balance of 130000 for 2030-02-01
   * Expected: 201 with the balance on the account; the list shows the latest balance; the history
   *           lists both days newest first
   */
  it('creates an account with an opening balance and records later balances', async () => {
    const w = await world()
    const a = await addAccount(w, w.home, {
      openingBalanceCents: 125000,
      openingBalanceDate: '2030-01-01',
    })
    expect(a).toMatchObject({ name: 'Checking', balanceCents: 125000, isManual: true })
    await w.admin.client.put(`/api/spaces/${w.home}/accounts/${a.id}/balances/2030-02-01`, {
      balanceCents: 130000,
    })
    const list = (await w.admin.client.get(`/api/spaces/${w.home}/accounts`)).body.accounts
    expect(list[0]).toMatchObject({ balanceCents: 130000, balanceDate: '2030-02-01' })
    const hist = (await w.admin.client.get(`/api/spaces/${w.home}/accounts/${a.id}/balances`)).body
      .balances
    expect(hist.map((b: { date: string }) => b.date)).toEqual(['2030-02-01', '2030-01-01'])
  })

  /**
   * Function: POST /accounts and PUT .../balances/:date validation (zod at the route boundary)
   * Inputs:   type "bogus"; a fractional opening balance 12.5; a balance for date "2030-13-40"
   * Expected: 400 invalid_input for each (money must be whole cents; dates must be real)
   */
  it('rejects bad types, fractional cents and impossible dates', async () => {
    const w = await world()
    expect(
      (await w.admin.client.post(`/api/spaces/${w.home}/accounts`, { name: 'X', type: 'bogus' }))
        .status,
    ).toBe(400)
    expect(
      (
        await w.admin.client.post(`/api/spaces/${w.home}/accounts`, {
          name: 'X',
          type: 'cash',
          openingBalanceCents: 12.5,
        })
      ).status,
    ).toBe(400)
    const a = await addAccount(w, w.home)
    const bad = await w.admin.client.put(
      `/api/spaces/${w.home}/accounts/${a.id}/balances/2030-13-40`,
      { balanceCents: 1 },
    )
    expect(bad.status).toBe(400)
  })

  /**
   * Function: account routes (authorization)
   * Inputs:   "val" (a viewer of HOME) listing and creating accounts; reading an account of HOME
   *           through BIZ's URL
   * Expected: listing 200; creating 403; the cross-Space read 404
   */
  it('lets a viewer read but not write, and scopes accounts to their Space', async () => {
    const w = await world()
    const a = await addAccount(w, w.home)
    expect((await w.val.client.get(`/api/spaces/${w.home}/accounts`)).status).toBe(200)
    expect(
      (await w.val.client.post(`/api/spaces/${w.home}/accounts`, { name: 'X', type: 'cash' }))
        .status,
    ).toBe(403)
    expect((await w.admin.client.get(`/api/spaces/${w.biz}/accounts/${a.id}`)).status).toBe(404)
  })
})

describe('transaction routes', () => {
  /**
   * Function: POST /transactions, GET /transactions (filters and paging)
   * Inputs:   three transactions (-1000 "Corner Market", -2500 "Gas", -300 "Coffee"); list with
   *           q=market, then limit=2 offset=1
   * Expected: 201 each; the search returns only the market one; paging returns 2 rows of total 3
   */
  it('creates, searches and pages transactions', async () => {
    const w = await world()
    const a = await addAccount(w, w.home)
    await addTxn(w, w.home, {
      accountId: a.id,
      amountCents: -1000,
      description: 'Corner Market',
      date: '2030-01-10',
    })
    await addTxn(w, w.home, {
      accountId: a.id,
      amountCents: -2500,
      description: 'Gas',
      date: '2030-01-11',
    })
    await addTxn(w, w.home, {
      accountId: a.id,
      amountCents: -300,
      description: 'Coffee',
      date: '2030-01-12',
    })
    const found = (await w.admin.client.get(`/api/spaces/${w.home}/transactions?q=market`)).body
    expect(found.transactions.map((t: { descriptionRaw: string }) => t.descriptionRaw)).toEqual([
      'Corner Market',
    ])
    const page = (await w.admin.client.get(`/api/spaces/${w.home}/transactions?limit=2&offset=1`))
      .body
    expect(page).toMatchObject({ total: 3, limit: 2, offset: 1 })
    expect(page.transactions).toHaveLength(2)
  })

  /**
   * Function: POST /transactions validation
   * Inputs:   amount 0; amount 12.5 (not whole cents); date "2030-02-30"; missing description
   * Expected: 400 invalid_input each time
   */
  it('rejects zero, fractional and malformed input', async () => {
    const w = await world()
    const a = await addAccount(w, w.home)
    for (const bad of [
      { amountCents: 0 },
      { amountCents: 12.5 },
      { amountCents: -100, date: '2030-02-30' },
      { amountCents: -100, description: '' },
    ]) {
      expect(
        (await addTxn(w, w.home, { accountId: a.id, ...bad })).status,
        JSON.stringify(bad),
      ).toBe(400)
    }
  })

  /**
   * Function: POST /transactions with unbalanced splits (CLAUDE.md rule 3)
   * Inputs:   -10000 split -6000 and -3999
   * Expected: 400 "splits_do_not_balance" with problem "sum_mismatch"; the list stays empty
   */
  it('returns a clear error when splits do not add up', async () => {
    const w = await world()
    const a = await addAccount(w, w.home)
    const res = await addTxn(w, w.home, {
      accountId: a.id,
      amountCents: -10000,
      splits: [
        { spaceId: w.home, amountCents: -6000 },
        { spaceId: w.home, amountCents: -3999 },
      ],
    })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'splits_do_not_balance', problem: 'sum_mismatch' })
    expect((await w.admin.client.get(`/api/spaces/${w.home}/transactions`)).body.total).toBe(0)
  })

  /**
   * Function: PATCH /transactions/:id, DELETE /transactions/:id
   * Inputs:   rename and mark private; then delete
   * Expected: the patch returns the updated transaction; delete returns ok and the transaction
   *           leaves the list
   */
  it('edits and deletes a transaction', async () => {
    const w = await world()
    const a = await addAccount(w, w.home)
    const id = (await addTxn(w, w.home, { accountId: a.id, amountCents: -1000 })).body.transaction
      .id
    const patched = await w.admin.client.patch(`/api/spaces/${w.home}/transactions/${id}`, {
      description: 'Renamed',
      private: true,
    })
    expect(patched.body.transaction).toMatchObject({ descriptionRaw: 'Renamed', private: true })
    expect((await w.admin.client.delete(`/api/spaces/${w.home}/transactions/${id}`)).status).toBe(
      200,
    )
    expect((await w.admin.client.get(`/api/spaces/${w.home}/transactions`)).body.total).toBe(0)
  })

  /**
   * Function: GET /transactions across Spaces (cross-Space privacy over HTTP)
   * Inputs:   a -6000 lunch on HOME's account split -4000 HOME / -2000 BIZ; listed from BIZ
   * Expected: BIZ gets the shared view: its -2000 split and the "other Spaces" -4000, with no
   *           account id; after marking it private the account name, total and other amount are null
   */
  it('shows the other Space a limited view, and less once private', async () => {
    const w = await world()
    const a = await addAccount(w, w.home)
    const id = (
      await addTxn(w, w.home, {
        accountId: a.id,
        amountCents: -6000,
        description: 'Team lunch',
        memo: 'hidden note',
        splits: [
          { spaceId: w.home, amountCents: -4000 },
          { spaceId: w.biz, amountCents: -2000 },
        ],
      })
    ).body.transaction.id
    const view = (await w.admin.client.get(`/api/spaces/${w.biz}/transactions`)).body
      .transactions[0]
    expect(view).toMatchObject({
      kind: 'shared',
      accountName: 'Checking',
      totalCents: -6000,
      otherSpacesCents: -4000,
    })
    expect(JSON.stringify(view)).not.toMatch(/hidden note|accountId/)
    await w.admin.client.patch(`/api/spaces/${w.home}/transactions/${id}`, { private: true })
    const priv = (await w.admin.client.get(`/api/spaces/${w.biz}/transactions`)).body
      .transactions[0]
    expect(priv).toMatchObject({ accountName: null, totalCents: null, otherSpacesCents: null })
  })

  /**
   * Function: POST /transfers, DELETE /transfers/:transactionId
   * Inputs:   -5000 on CHECKING and +5000 on SAVINGS; link; link again; unlink
   * Expected: 201 on first link; 409 "already_linked" on the second; the detail endpoint shows the
   *           transfer; unlink returns ok
   */
  it('links and unlinks a transfer between two accounts', async () => {
    const w = await world()
    const a = await addAccount(w, w.home)
    const b = await addAccount(w, w.home, { name: 'Savings', type: 'savings' })
    const out = (await addTxn(w, w.home, { accountId: a.id, amountCents: -5000 })).body.transaction
      .id
    const inn = (await addTxn(w, w.home, { accountId: b.id, amountCents: 5000 })).body.transaction
      .id
    const link = await w.admin.client.post(`/api/spaces/${w.home}/transfers`, {
      transactionId: out,
      otherTransactionId: inn,
    })
    expect(link.status).toBe(201)
    expect(
      (
        await w.admin.client.post(`/api/spaces/${w.home}/transfers`, {
          transactionId: out,
          otherTransactionId: inn,
        })
      ).body.error,
    ).toBe('already_linked')
    expect(
      (await w.admin.client.get(`/api/spaces/${w.home}/transactions/${out}`)).body.transfer,
    ).toMatchObject({ fromTransactionId: out, toTransactionId: inn })
    expect((await w.admin.client.delete(`/api/spaces/${w.home}/transfers/${out}`)).status).toBe(200)
  })
})
