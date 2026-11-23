import { describe, expect, it } from 'vitest'
import {
  Client,
  bootstrapAdmin,
  createUser,
  makeEnv,
  type Account,
  type TestEnv,
} from '../testing/harness'

/**
 * HTTP-level tests of the rules and CSV import routes (/api/spaces/:spaceId/rules and /imports).
 * The real app runs on in-memory fakes with sessions, CSRF, zod validation and the Space permission
 * middleware. Business rules are covered in rules/service.test.ts and imports/service.test.ts; this
 * checks wiring, validation, authorization and the large-upload path.
 *
 * Mock data: "admin", "val" (viewer of Space HOME), a personal Space HOME with a checking account.
 */

interface World {
  env: TestEnv
  admin: Account
  val: Account
  home: string
  account: string
  groceries: string
}

async function world(): Promise<World> {
  const env = makeEnv()
  const admin = await bootstrapAdmin(env)
  const val = await createUser(env, admin, 'val')
  const home = (await admin.client.post('/api/spaces', { name: 'Home', type: 'personal' })).body
    .space.id
  await admin.client.put(`/api/spaces/${home}/members/${val.id}`, { role: 'viewer' })
  const account = (
    await admin.client.post(`/api/spaces/${home}/accounts`, { name: 'Checking', type: 'checking' })
  ).body.account.id
  const cats = (await admin.client.get(`/api/spaces/${home}/categories`)).body.categories
  return {
    env,
    admin,
    val,
    home,
    account,
    groceries: cats.find((c: { name: string }) => c.name === 'Groceries').id,
  }
}

const MAPPING = {
  hasHeader: true,
  dateColumn: 0,
  dateFormat: 'YYYY-MM-DD',
  descriptionColumn: 1,
  amount: { mode: 'single', column: 2, invert: false },
}
const CSV = 'Date,Description,Amount\n2030-01-05,CORNER MARKET,-42.50\n2030-01-06,PAYROLL,2000.00'

describe('rules routes', () => {
  /**
   * Function: POST/GET/PATCH/DELETE /api/spaces/:spaceId/rules
   * Inputs:   create a rule ("market" -> Groceries), list, disable it, delete it
   * Expected: 201 with the rule; listed; the patch returns it disabled; delete returns ok and the list is empty
   */
  it('creates, lists, edits and deletes a rule', async () => {
    const w = await world()
    const base = `/api/spaces/${w.home}/rules`
    const created = await w.admin.client.post(base, {
      name: 'Market',
      conditions: [{ type: 'text', field: 'description', op: 'contains', value: 'market' }],
      actions: [{ type: 'set_category', categoryId: w.groceries }],
    })
    expect(created.status).toBe(201)
    const id = created.body.rule.id
    expect((await w.admin.client.get(base)).body.rules).toHaveLength(1)
    expect(
      (await w.admin.client.patch(`${base}/${id}`, { enabled: false })).body.rule.enabled,
    ).toBe(false)
    expect((await w.admin.client.delete(`${base}/${id}`)).status).toBe(200)
    expect((await w.admin.client.get(base)).body.rules).toEqual([])
  })
  /**
   * Function: POST /rules validation (zod)
   * Inputs:   no conditions; no actions; an empty text value; an amount condition with min greater than max;
   *           an unknown action type
   * Expected: 400 invalid_input for each
   */
  it('rejects incomplete or inconsistent rules', async () => {
    const w = await world()
    const post = (body: object) =>
      w.admin.client.post(`/api/spaces/${w.home}/rules`, { name: 'r', ...body })
    const ok = {
      conditions: [{ type: 'text', field: 'description', op: 'contains', value: 'x' }],
      actions: [{ type: 'set_payee', payee: 'X' }],
    }
    expect((await post({ ...ok, conditions: [] })).status).toBe(400)
    expect((await post({ ...ok, actions: [] })).status).toBe(400)
    expect(
      (
        await post({
          ...ok,
          conditions: [{ type: 'text', field: 'description', op: 'contains', value: '' }],
        })
      ).status,
    ).toBe(400)
    expect(
      (await post({ ...ok, conditions: [{ type: 'amount', minCents: 500, maxCents: 100 }] }))
        .status,
    ).toBe(400)
    expect((await post({ ...ok, actions: [{ type: 'explode' }] })).status).toBe(400)
  })
  /**
   * Function: POST /rules/preview and POST /rules/run, then GET /transactions
   * Inputs:   two uncategorized transactions (one "market"); preview "contains market"; add the rule and run it
   * Expected: preview says 1 of 2 matches with a sample; run reports 1 changed; the matching transaction is
   *           now categorized
   */
  it('previews a rule and runs it on existing transactions', async () => {
    const w = await world()
    const add = (description: string) =>
      w.admin.client.post(`/api/spaces/${w.home}/transactions`, {
        accountId: w.account,
        date: '2030-01-10',
        amountCents: -1000,
        description,
      })
    await add('CORNER MARKET')
    await add('GAS STATION')
    const cond = [{ type: 'text', field: 'description', op: 'contains', value: 'market' }]
    const p = await w.admin.client.post(`/api/spaces/${w.home}/rules/preview`, { conditions: cond })
    expect(p.body).toMatchObject({ examined: 2, matched: 1 })
    expect(p.body.samples).toHaveLength(1)
    await w.admin.client.post(`/api/spaces/${w.home}/rules`, {
      name: 'Market',
      conditions: cond,
      actions: [{ type: 'set_category', categoryId: w.groceries }],
    })
    expect(
      (await w.admin.client.post(`/api/spaces/${w.home}/rules/run`)).body.summary,
    ).toMatchObject({ changed: 1 })
    const list = (await w.admin.client.get(`/api/spaces/${w.home}/transactions?q=market`)).body
      .transactions
    expect(list[0].splits[0].categoryId).toBe(w.groceries)
  })
  /**
   * Function: rules authorization
   * Inputs:   "val" (a viewer) listing and creating a rule
   * Expected: listing 200; creating 403
   */
  it('lets a viewer read rules but not change them', async () => {
    const w = await world()
    expect((await w.val.client.get(`/api/spaces/${w.home}/rules`)).status).toBe(200)
    const body = {
      name: 'r',
      conditions: [{ type: 'direction', direction: 'out' }],
      actions: [{ type: 'mark_reimbursable' }],
    }
    expect((await w.val.client.post(`/api/spaces/${w.home}/rules`, body)).status).toBe(403)
  })
})

describe('CSV import routes', () => {
  /**
   * Function: POST /imports/preview then POST /imports, then GET /imports and /transactions
   * Inputs:   preview with no mapping, preview with the suggested mapping, commit
   * Expected: the first suggests a mapping; the second lists 2 new rows; the commit returns 201 with 2
   *           imported; the batch is listed; the transactions exist
   */
  it('previews, commits, and lists the batch', async () => {
    const w = await world()
    const url = `/api/spaces/${w.home}/imports`
    const first = await w.admin.client.post(`${url}/preview`, { accountId: w.account, csv: CSV })
    expect(first.body.preview.suggestedMapping).toMatchObject({ hasHeader: true, dateColumn: 0 })
    const second = await w.admin.client.post(`${url}/preview`, {
      accountId: w.account,
      csv: CSV,
      mapping: MAPPING,
    })
    expect(second.body.preview.counts).toEqual({ total: 2, new: 2, duplicate: 0, invalid: 0 })
    const done = await w.admin.client.post(url, {
      accountId: w.account,
      filename: 'jan.csv',
      csv: CSV,
      mapping: MAPPING,
    })
    expect(done.status).toBe(201)
    expect(done.body.result).toMatchObject({ imported: 2 })
    expect((await w.admin.client.get(url)).body.imports[0]).toMatchObject({
      filename: 'jan.csv',
      rowCount: 2,
    })
    expect((await w.admin.client.get(`/api/spaces/${w.home}/transactions`)).body.total).toBe(2)
  })
  /**
   * Function: POST /imports validation and errors
   * Inputs:   a malformed mapping; an unterminated-quote file; an empty CSV string; committing the same
   *           file again (all duplicates)
   * Expected: 400 invalid_input; 400 bad_csv with a message; 400 invalid_input; 400 nothing_to_import
   */
  it('reports bad input clearly', async () => {
    const w = await world()
    const url = `/api/spaces/${w.home}/imports`
    expect(
      (
        await w.admin.client.post(`${url}/preview`, {
          accountId: w.account,
          csv: CSV,
          mapping: { hasHeader: true },
        })
      ).status,
    ).toBe(400)
    const bad = await w.admin.client.post(`${url}/preview`, {
      accountId: w.account,
      csv: 'a,"b\nc',
    })
    expect(bad.body).toMatchObject({ error: 'bad_csv' })
    expect(bad.body.message).toBeTruthy()
    expect(
      (await w.admin.client.post(`${url}/preview`, { accountId: w.account, csv: '' })).status,
    ).toBe(400)
    await w.admin.client.post(url, {
      accountId: w.account,
      filename: 'a.csv',
      csv: CSV,
      mapping: MAPPING,
    })
    const again = await w.admin.client.post(url, {
      accountId: w.account,
      filename: 'a.csv',
      csv: CSV,
      mapping: MAPPING,
    })
    expect(again.body.error).toBe('nothing_to_import')
  })
  /**
   * Function: POST /imports/preview with a large file
   * Inputs:   a CSV of 20,000 rows (about 1 MB of text) and one over the 6 MB limit
   * Expected: the big valid file is accepted and all rows are parsed (the upload size limit is raised for
   *           this route only); the oversized one is rejected with 400/413, not a crash
   */
  it('accepts large files within the limit and rejects ones beyond it', async () => {
    const w = await world()
    const rows = Array.from(
      { length: 20_000 },
      (_, i) => `2030-01-${String((i % 27) + 1).padStart(2, '0')},ROW ${i},-${(i % 90) + 1}.00`,
    )
    const big = ['Date,Description,Amount', ...rows].join('\n')
    expect(big.length).toBeGreaterThan(500_000)
    const ok = await w.admin.client.post(`/api/spaces/${w.home}/imports/preview`, {
      accountId: w.account,
      csv: big,
      mapping: MAPPING,
    })
    expect(ok.status).toBe(200)
    expect(ok.body.preview.counts.total).toBe(20_000)
    const huge = await w.admin.client.post(`/api/spaces/${w.home}/imports/preview`, {
      accountId: w.account,
      csv: 'x'.repeat(6_500_000),
    })
    expect([400, 413]).toContain(huge.status)
  }, 30_000)
  /**
   * Function: import authorization
   * Inputs:   "val" (a viewer) previewing and committing; and an anonymous caller
   * Expected: 403 for the viewer on both; 401 for anonymous
   */
  it('needs edit rights to preview or import', async () => {
    const w = await world()
    const url = `/api/spaces/${w.home}/imports`
    expect(
      (await w.val.client.post(`${url}/preview`, { accountId: w.account, csv: CSV })).status,
    ).toBe(403)
    expect(
      (
        await w.val.client.post(url, {
          accountId: w.account,
          filename: 'x.csv',
          csv: CSV,
          mapping: MAPPING,
        })
      ).status,
    ).toBe(403)
    expect(
      (await new Client(w.env.app).post(`${url}/preview`, { accountId: w.account, csv: CSV }))
        .status,
    ).toBe(401)
  })
})
