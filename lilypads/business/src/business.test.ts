import type { PadTransaction, ScopedCore } from '@pond/sdk'
import { createTestPad } from '@pond/sdk/testing'
import type { CategoryView } from '@pond/shared'
import { describe, expect, it } from 'vitest'
import { padModule } from './index'

/**
 * The Business pad on the SDK's in-memory host: no Pond and no database. Every name, address and
 * tax ID here is made up (the IDs start 000, which is never issued).
 */
const TAX_ID = '000-12-3456'
const PDF = new TextEncoder().encode('%PDF-1.7 made-up form')

const cat = (
  id: string,
  name: string,
  kind: CategoryView['kind'],
  taxLine: string | null = null,
): CategoryView => ({
  id,
  spaceId: 'space-1',
  parentId: null,
  name,
  kind,
  taxLine,
  sortOrder: 0,
  archivedAt: null,
})
const categories = [
  cat('sales', 'Sales', 'income'),
  cat('meals', 'Meals', 'expense', 'Line 24b'),
  cat('xfer', 'Transfer', 'transfer'),
]

function fakeCore(transactions: PadTransaction[] = [], total = transactions.length) {
  const asked: { from: string; to: string }[] = []
  const core: Partial<ScopedCore> = {
    categories: { list: async () => categories },
    splits: {
      sum: async (o) => {
        asked.push({ from: o.from, to: o.to })
        return [
          { categoryId: 'sales', kind: 'income', month: null, cents: 90000, count: 2 },
          { categoryId: 'meals', kind: 'expense', month: null, cents: -5000, count: 1 },
        ]
      },
    },
    transactions: {
      list: async (o) => ({
        transactions: transactions.slice(o?.offset ?? 0, (o?.offset ?? 0) + (o?.limit ?? 50)),
        total,
      }),
      get: async () => null,
    },
  }
  return { core, asked }
}
const setup = async (transactions?: PadTransaction[], total?: number) => {
  const f = fakeCore(transactions, total)
  return { ...f, t: await createTestPad(padModule, { core: f.core }) }
}

const profile = (extra: Record<string, unknown> = {}) => ({
  legalName: 'Example Goods',
  businessType: 'nonprofit',
  address: '',
  phone: null,
  taxYearStartMonth: 1,
  ...extra,
})
const person = (extra: Record<string, unknown> = {}) => ({
  firstName: 'Pat',
  lastName: 'Sample',
  relationship: 'contractor',
  email: '',
  phone: '',
  address: '',
  startDate: null,
  endDate: null,
  ...extra,
})
type T = Awaited<ReturnType<typeof createTestPad>>
const addPerson = async (t: T, extra = {}) =>
  (
    (await t.call('POST', '/people', { body: person(extra) })).body as {
      person: { id: string; taxIdMasked: string | null }
    }
  ).person

describe('what the pad asks for and who may call it', () => {
  /**
   * Function: the manifest and every registered route
   * Inputs:   the pad as shipped
   * Expected: only transactions:read, secrets:use and files:store; business Spaces only; no
   *           settings; everything about the profile, people and documents is owner only; reports
   *           are open to viewers, except changing what is partly counted; only the two tax ID
   *           reveals need the password again
   */
  it('keeps private things owner only, and asks for no more than it needs', async () => {
    const m = padModule.manifest
    expect(m.permissions).toEqual(['transactions:read', 'secrets:use', 'files:store'])
    expect(m.spaceTypes).toEqual(['business'])
    const routes = (await createTestPad(padModule)).routes()
    for (const r of routes) {
      const open = r.method === 'GET' && r.path.startsWith('/reports/')
      expect(r.role, `${r.method} ${r.path}`).toBe(open ? 'viewer' : 'owner')
    }
    const t = await createTestPad(padModule)
    const id = (await addPerson(t, { taxId: TAX_ID })).id
    await t.call('PUT', '/profile', { body: profile({ taxId: TAX_ID }) })
    for (const path of ['/profile/tax-id', `/people/${id}/tax-id`])
      expect((await t.call('GET', path, { reauthed: false })).body).toEqual({
        error: 'reauth_required',
      })
    expect((await t.call('GET', '/people', { reauthed: false })).status).toBe(200)
  })

  /**
   * Function: a fresh install
   * Inputs:   no data at all
   * Expected: reports work at once; the profile is empty with a January tax year; no people or
   *           documents (the pad ships with nothing in it)
   */
  it('ships empty and works with no setup', async () => {
    const { t } = await setup()
    expect((await t.call('GET', '/profile')).body).toEqual({
      profile: {
        legalName: null,
        businessType: null,
        address: null,
        phone: null,
        taxYearStartMonth: 1,
        taxIdMasked: null,
      },
    })
    expect((await t.call('GET', '/people')).body).toEqual({ people: [] })
    expect((await t.call('GET', '/documents')).body).toEqual({ documents: [] })
    const pl = await t.call('GET', '/reports/profit-loss', {
      role: 'viewer',
      query: { from: '2030-01-01', to: '2030-12-31' },
    })
    expect(pl.body).toMatchObject({ totals: { netCents: 85000 } })
  })
})

describe('tax IDs', () => {
  /**
   * Function: PUT /profile, POST /people, the list routes and the reveal routes
   * Inputs:   a made-up tax ID on the business and on a person
   * Expected: stored only through ctx.secrets; every response except the reveals shows
   *           "•••••3456"; the reveals return it and are audited; it is in no audit entry or log
   */
  it('are stored encrypted, shown masked, and revealed only on request', async () => {
    const { t } = await setup()
    const saved = await t.call('PUT', '/profile', { body: profile({ taxId: TAX_ID }) })
    const added = await addPerson(t, { taxId: TAX_ID })
    expect(added.taxIdMasked).toBe('•••••3456')
    expect((await t.table('people').findOne({}))!.tax_id_enc).toBe(`test:${TAX_ID}`)
    expect((await t.table('profile').findOne({}))!.tax_id_enc).toBe(`test:${TAX_ID}`)
    const responses = [saved, await t.call('GET', '/profile'), await t.call('GET', '/people')]
    for (const r of responses) {
      expect(JSON.stringify(r.body)).toContain('•••••3456')
      expect(JSON.stringify(r.body)).not.toContain(TAX_ID)
      expect(JSON.stringify(r.body)).not.toContain('tax_id_enc')
    }
    expect((await t.call('GET', '/profile/tax-id')).body).toEqual({ taxId: TAX_ID })
    expect((await t.call('GET', `/people/${added.id}/tax-id`)).body).toEqual({ taxId: TAX_ID })
    expect(t.audit.filter((a) => a.action.endsWith('taxid.revealed'))).toHaveLength(2)
    expect(JSON.stringify([t.audit, t.logs])).not.toContain(TAX_ID)
  })

  /**
   * Function: updating a tax ID
   * Inputs:   save without a taxId field; then with null
   * Expected: left as it was; then removed, and the reveal gives 404
   */
  it('keeps a tax ID unless asked to change or remove it', async () => {
    const { t } = await setup()
    const id = (await addPerson(t, { taxId: TAX_ID })).id
    await t.call('PUT', `/people/${id}`, { body: person({ phone: '555-0100' }) })
    expect((await t.call('GET', `/people/${id}/tax-id`)).status).toBe(200)
    await t.call('PUT', `/people/${id}`, { body: person({ taxId: null }) })
    expect((await t.call('GET', `/people/${id}/tax-id`)).status).toBe(404)
  })

  /**
   * Function: validation of people and the profile
   * Inputs:   a tax ID with symbols, one too short, an end date before the start date, an unknown
   *           relationship and business type, and month 13
   * Expected: 400 each, and nothing stored
   */
  it('validates before saving', async () => {
    const { t } = await setup()
    for (const bad of [
      { taxId: '<script>' },
      { taxId: '12' },
      { startDate: '2030-02-01', endDate: '2030-01-01' },
      { relationship: 'friend' },
    ])
      expect((await t.call('POST', '/people', { body: person(bad) })).status).toBe(400)
    for (const bad of [{ businessType: 'club' }, { taxYearStartMonth: 13 }])
      expect((await t.call('PUT', '/profile', { body: profile(bad) })).status).toBe(400)
    expect(await t.table('people').count()).toBe(0)
    expect(await t.table('profile').count()).toBe(0)
  })

  /**
   * Function: the profile table across Spaces
   * Inputs:   two Spaces each save a profile; one saves twice
   * Expected: one profile row per Space, each with its own values
   */
  it('keeps one profile per Space', async () => {
    const { t } = await setup()
    await t.call('PUT', '/profile', { body: profile({ legalName: 'One' }) })
    await t.call('PUT', '/profile', { body: profile({ legalName: 'Uno' }) })
    const two = await t.call('PUT', '/profile', {
      body: profile({ legalName: 'Two' }),
      spaceId: 'space-2',
    })
    expect(two.status).toBe(200)
    expect((await t.call('GET', '/profile')).body).toMatchObject({ profile: { legalName: 'Uno' } })
    expect(await t.table('profile').count()).toBe(1)
    expect(await t.table('profile', 'space-2').count()).toBe(1)
  })
})

describe('pay history and removing a person', () => {
  /**
   * Function: POST/GET/DELETE /people/:id/pay
   * Inputs:   two pay records added out of order; a zero amount; an unknown person and record id
   * Expected: listed newest first, exactly as entered (no totals); 400 for zero; 404 for unknowns
   */
  it('keeps a record of pay without calculating anything', async () => {
    const { t } = await setup()
    const id = (await addPerson(t)).id
    const pay = (amountCents: number, effectiveDate: string, per = 'year') =>
      t.call('POST', `/people/${id}/pay`, {
        body: { amountCents, per, effectiveDate, note: '' },
      })
    await pay(5000000, '2029-01-01')
    await pay(2500, '2030-01-01', 'hour')
    expect((await pay(0, '2030-01-01')).status).toBe(400)
    const list = (await t.call('GET', `/people/${id}/pay`)).body as {
      pay: { amountCents: number; per: string }[]
    }
    expect(list.pay.map((p) => [p.amountCents, p.per])).toEqual([
      [2500, 'hour'],
      [5000000, 'year'],
    ])
    expect(Object.keys(list)).toEqual(['pay'])
    expect((await t.call('GET', '/people/nope/pay')).status).toBe(404)
    expect((await t.call('DELETE', `/people/${id}/pay/nope`)).status).toBe(404)
  })

  /**
   * Function: DELETE /people/:id
   * Inputs:   a person with pay history and a document, next to another person with a document
   * Expected: the person, their pay, their document row and its file are gone; the other's remain
   */
  it('removes everything held about that person and nothing else', async () => {
    const { t } = await setup()
    const a = (await addPerson(t)).id
    const b = (await addPerson(t, { firstName: 'Sam' })).id
    await t.call('POST', `/people/${a}/pay`, {
      body: { amountCents: 1, per: 'hour', effectiveDate: '2030-01-01', note: null },
    })
    for (const personId of [a, b])
      await t.call('POST', '/documents', {
        file: PDF,
        query: { filename: 'w9.pdf', type: 'tax_form', personId },
      })
    expect(t.files()).toHaveLength(2)
    expect((await t.call('DELETE', `/people/${a}`)).status).toBe(200)
    expect(await t.table('people').count()).toBe(1)
    expect(await t.table('pay_records').count()).toBe(0)
    expect((await t.table('documents').find()).map((d) => d.person_id)).toEqual([b])
    expect(t.files()).toHaveLength(1)
  })
})

describe('documents', () => {
  /**
   * Function: POST, GET, download and DELETE /documents
   * Inputs:   a tax form for a person (2030) and a receipt; filters by type, year and person
   * Expected: both listed with the person's name; filters narrow the list; the download returns the
   *           same bytes under the original name and is audited; delete removes the row and file
   */
  it('stores, finds, returns and removes documents', async () => {
    const { t } = await setup()
    const personId = (await addPerson(t)).id
    const up = (query: Record<string, unknown>) =>
      t.call('POST', '/documents', { file: PDF, query })
    const id = (
      (await up({ filename: 'w9.pdf', type: 'tax_form', taxYear: '2030', personId })).body as {
        id: string
      }
    ).id
    await up({ filename: 'lunch.pdf', type: 'receipt' })
    const list = async (query = {}) =>
      (
        (await t.call('GET', '/documents', { query })).body as {
          documents: { filename: string; personName: string | null }[]
        }
      ).documents
    expect(await list()).toHaveLength(2)
    expect(await list({ type: 'tax_form' })).toMatchObject([{ personName: 'Pat Sample' }])
    expect(await list({ taxYear: '2030' })).toHaveLength(1)
    expect(await list({ personId })).toHaveLength(1)
    const got = await t.call('GET', `/documents/${id}/download`)
    expect(got.download!.filename).toBe('w9.pdf')
    expect([...got.download!.bytes]).toEqual([...PDF])
    expect(t.audit.map((a) => a.action)).toContain('lilypad.business.document.downloaded')
    await t.call('DELETE', `/documents/${id}`)
    expect(await list()).toHaveLength(1)
    expect(t.files()).toHaveLength(1)
  })

  /**
   * Function: document upload checks
   * Inputs:   a text file, an unknown document type, and a person who doesn't exist
   * Expected: 415, 400 and 404; no row and no file is left behind
   */
  it('leaves nothing behind when an upload is refused', async () => {
    const { t } = await setup()
    const up = (query: Record<string, unknown>, file = PDF) =>
      t.call('POST', '/documents', { file, query })
    expect(
      (await up({ filename: 'a.pdf', type: 'other' }, new TextEncoder().encode('hello'))).status,
    ).toBe(415)
    expect((await up({ filename: 'a.pdf', type: 'secret' })).status).toBe(400)
    expect((await up({ filename: 'a.pdf', type: 'other', personId: 'nope' })).status).toBe(404)
    expect(await t.table('documents').count()).toBe(0)
    expect(t.files()).toEqual([])
  })
})

describe('reports', () => {
  /**
   * Function: GET /reports/tax-summary with a tax year starting in July
   * Inputs:   year 2030; Meals marked 50% counted, then set back to 100
   * Expected: totals are asked for 2030-07-01 to 2031-06-30; Meals counts 2500 of 5000; after
   *           setting 100 no row remains and it counts in full
   */
  it('follows the tax year and the partly counted categories', async () => {
    const { t, asked } = await setup()
    await t.call('PUT', '/profile', { body: profile({ taxYearStartMonth: 7 }) })
    const set = (percent: number | null) =>
      t.call('PUT', '/reports/deductions/meals', { body: { percent } })
    await set(50)
    const summary = async () =>
      (await t.call('GET', '/reports/tax-summary', { role: 'viewer', query: { year: '2030' } }))
        .body as { totals: { countedExpenseCents: number } }
    expect((await summary()).totals.countedExpenseCents).toBe(2500)
    expect(asked.at(-1)).toEqual({ from: '2030-07-01', to: '2031-06-30' })
    await set(100)
    expect(await t.table('deductions').count()).toBe(0)
    expect((await summary()).totals.countedExpenseCents).toBe(5000)
    expect((await t.call('GET', '/reports/context', { role: 'viewer' })).body).toEqual({
      taxYearStartMonth: 7,
    })
  })

  /**
   * Function: PUT /reports/deductions/:categoryId
   * Inputs:   an editor; an income category; an unknown category; 101 percent
   * Expected: 403; 400 invalid_category twice; 400
   */
  it('only lets owners mark real expense categories', async () => {
    const { t } = await setup()
    const put = (id: string, percent: number, role: 'owner' | 'editor' = 'owner') =>
      t.call('PUT', `/reports/deductions/${id}`, { role, body: { percent } })
    expect((await put('meals', 50, 'editor')).status).toBe(403)
    expect((await put('sales', 50)).body).toEqual({ error: 'invalid_category' })
    expect((await put('nope', 50)).body).toEqual({ error: 'invalid_category' })
    expect((await put('meals', 101)).status).toBe(400)
  })

  /**
   * Function: report date checks
   * Inputs:   a start after the end, and an impossible date
   * Expected: 400 for both
   */
  it('refuses ranges that make no sense', async () => {
    const { t } = await setup()
    for (const query of [
      { from: '2030-02-01', to: '2030-01-01' },
      { from: '2030-02-30', to: '2030-03-01' },
    ])
      expect((await t.call('GET', '/reports/profit-loss', { query })).status).toBe(400)
  })

  const txn = (
    n: number,
    splits: { spaceId: string; categoryId: string | null; amountCents: number }[],
    extra: Record<string, unknown> = {},
  ) =>
    ({
      kind: 'shared',
      id: `t${n}`,
      date: `2030-01-${String(28 - (n % 27)).padStart(2, '0')}`,
      descriptionRaw: `Purchase ${n}`,
      payee: null,
      pending: false,
      linkedTransfer: false,
      splits: splits.map((s) => ({ ...s, memo: null })),
      ...extra,
    }) as unknown as PadTransaction

  /**
   * Function: GET /reports/export
   * Inputs:   a transaction split between this Space and another; a linked transfer; a hostile bank
   *           description starting with "="; an uncategorized split
   * Expected: only this Space's splits appear; types read expense, transfer and uncategorized; the
   *           formula is escaped; amounts keep their sign; rows are in date order
   */
  it('exports only this Space’s money, safely', async () => {
    const { t } = await setup([
      txn(1, [
        { spaceId: 'space-1', categoryId: 'meals', amountCents: -1250 },
        { spaceId: 'personal', categoryId: 'secret', amountCents: -999999 },
      ]),
      txn(2, [{ spaceId: 'space-1', categoryId: null, amountCents: 5000 }], {
        linkedTransfer: true,
      }),
      txn(3, [{ spaceId: 'space-1', categoryId: null, amountCents: -100 }], {
        descriptionRaw: '=cmd|calc',
        payee: 'A, B',
      }),
    ])
    const r = await t.call('GET', '/reports/export', {
      role: 'viewer',
      query: { from: '2030-01-01', to: '2030-01-31' },
    })
    const { csv, filename } = r.body as { csv: string; filename: string }
    expect(filename).toBe('transactions-2030-01-01-to-2030-01-31.csv')
    expect(csv.trimEnd().split('\r\n')).toEqual([
      'Date,Description,Payee,Amount,Type,Category,Tax line,Memo,Pending',
      `2030-01-25,'=cmd|calc,"A, B",-1.00,uncategorized,,,,`,
      '2030-01-26,Purchase 2,,50.00,transfer,,,,',
      '2030-01-27,Purchase 1,,-12.50,expense,Meals,Line 24b,,',
    ])
    expect(csv).not.toContain('9999.99')
  })

  /**
   * Function: GET /reports/export (paging and size limit)
   * Inputs:   450 transactions (more than two pages); then a range holding 20,001
   * Expected: all 450 rows are exported; the huge range is refused with too_many_to_export
   */
  it('reads every page, and refuses an export too big for a small computer', async () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      txn(i, [{ spaceId: 'space-1', categoryId: 'meals', amountCents: -1 }]),
    )
    const query = { from: '2030-01-01', to: '2030-01-31' }
    const { t } = await setup(many)
    const r = await t.call('GET', '/reports/export', { query })
    expect((r.body as { csv: string }).csv.trimEnd().split('\r\n')).toHaveLength(451)
    const big = await setup(many, 20_001)
    expect((await big.t.call('GET', '/reports/export', { query })).body).toEqual({
      error: 'too_many_to_export',
    })
  })
})
