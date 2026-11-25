import { padModule as businessPad } from '@pond/lilypad-business'
import { describe, expect, it } from 'vitest'
import { PASSWORD, bootstrapAdmin, createUser, makeEnv } from '../testing/harness'

/**
 * The real Business pad on the real host: real sessions, Space roles, the password re-check and
 * the scoped core view (in-memory fakes instead of a database and disk). Names and IDs are made up.
 */
async function world() {
  const env = makeEnv({ pads: [businessPad] })
  const admin = await bootstrapAdmin(env)
  const olga = await createUser(env, admin, 'olga', '10.3.0.1')
  const ed = await createUser(env, admin, 'eddie', '10.3.0.2')
  const space = async (name: string, type: 'business' | 'personal') =>
    (await admin.client.post('/api/spaces', { name, type, ownerUserId: olga.id })).body.space
      .id as string
  const biz = await space('Example Goods', 'business')
  const home = await space('Home', 'personal')
  await olga.client.put(`/api/spaces/${biz}/members/${ed.id}`, { role: 'editor' })
  const installed = await admin.client.post('/api/lilypads/business/install', {
    permissions: ['transactions:read', 'secrets:use', 'files:store'],
  })
  expect(installed.body.pad).toMatchObject({ state: 'running', problem: null })
  await olga.client.put(`/api/spaces/${biz}/pads/business/enabled`, { enabled: true })
  const url = (path: string) => `/api/spaces/${biz}/lilypads/business${path}`
  return { env, admin, olga, ed, biz, home, url }
}

describe('the Business pad on Pond', () => {
  /**
   * Function: enabling the pad
   * Inputs:   the owner turns it on for a personal Space
   * Expected: refused, because it is for business Spaces only
   */
  it('is only offered to business Spaces', async () => {
    const w = await world()
    const r = await w.olga.client.put(`/api/spaces/${w.home}/pads/business/enabled`, {
      enabled: true,
    })
    expect(r.body.error).toBe('space_type_not_supported')
  })

  /**
   * Function: roles and the tax ID reveal through real middleware
   * Inputs:   an editor and the owner; a made-up tax ID; the reveal 6 minutes after signing in,
   *           then after the password is entered again
   * Expected: the editor sees reports but not people or the reveal; the owner gets
   *           reauth_required, then the ID; it is stored encrypted and is in no audit entry
   */
  it('guards private details', async () => {
    const w = await world()
    const added = await w.olga.client.post(w.url('/people'), {
      firstName: 'Pat',
      lastName: 'Sample',
      relationship: 'employee',
      email: null,
      phone: null,
      address: null,
      startDate: null,
      endDate: null,
      taxId: '000-12-3456',
    })
    const id = added.body.person.id
    expect(added.body.person.taxIdMasked).toBe('•••••3456')
    const reports = w.url('/reports/profit-loss?from=2030-01-01&to=2030-12-31')
    expect((await w.ed.client.get(reports)).status).toBe(200)
    expect((await w.ed.client.get(w.url('/people'))).status).toBe(403)
    expect((await w.ed.client.get(w.url(`/people/${id}/tax-id`))).status).toBe(403)

    w.env.advance(6 * 60_000)
    const reveal = () => w.olga.client.get(w.url(`/people/${id}/tax-id`))
    expect((await reveal()).body.error).toBe('reauth_required')
    await w.olga.client.post('/api/auth/reauth', { password: PASSWORD })
    expect((await reveal()).body).toEqual({ taxId: '000-12-3456' })

    const audit = JSON.stringify(w.env.ctx.repos.audit.list({ limit: 200 }))
    expect(audit).toContain('lilypad.business.taxid.revealed')
    expect(audit).toContain('lilypad.reauth_access')
    expect(audit).not.toContain('000-12-3456')
  })

  /**
   * Function: reports and export from real core data
   * Inputs:   a business account with a sale and a supplies purchase, plus a transfer between two
   *           accounts linked as a transfer
   * Expected: profit and loss counts the sale and the purchase only; the export lists all four and
   *           labels both sides of the transfer
   */
  it('reports on the Space’s own splits and labels linked transfers', async () => {
    const w = await world()
    const api = `/api/spaces/${w.biz}`
    const account = async (name: string) =>
      (await w.olga.client.post(`${api}/accounts`, { name, type: 'checking' })).body.account.id
    const [a, b] = [await account('Operating'), await account('Reserve')]
    const categories = (await w.olga.client.get(`${api}/categories`)).body.categories
    const category = (name: string) =>
      categories.find((c: { name: string }) => c.name === name).id as string
    const txn = async (
      accountId: string,
      amountCents: number,
      description: string,
      categoryId: string | null,
    ) =>
      (
        await w.olga.client.post(`${api}/transactions`, {
          accountId,
          date: '2030-03-01',
          amountCents,
          description,
          splits: [{ spaceId: w.biz, categoryId, amountCents }],
        })
      ).body.transaction.id as string
    await txn(a, 100000, 'Sale', category('Gross Receipts / Sales'))
    await txn(a, -2500, 'Paper', category('Supplies'))
    const out = await txn(a, -40000, 'To reserve', null)
    const into = await txn(b, 40000, 'From operating', null)
    const linked = await w.olga.client.post(`${api}/transfers`, {
      transactionId: out,
      otherTransactionId: into,
    })
    expect(linked.status, JSON.stringify(linked.body)).toBeLessThan(300)

    const range = 'from=2030-01-01&to=2030-12-31'
    const pl = (await w.olga.client.get(w.url(`/reports/profit-loss?${range}`))).body
    expect(pl.totals).toEqual({ incomeCents: 100000, expenseCents: 2500, netCents: 97500 })
    expect(pl.uncategorized.count).toBe(0)
    const csv = (await w.olga.client.get(w.url(`/reports/export?${range}`))).body.csv as string
    const types = csv
      .trimEnd()
      .split('\r\n')
      .slice(1)
      .map((line) => line.split(',')[4])
    expect(types.sort()).toEqual(['expense', 'income', 'transfer', 'transfer'])
  })
})
