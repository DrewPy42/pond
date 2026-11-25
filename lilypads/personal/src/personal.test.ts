import type { PadTransaction, ScopedCore, SplitSumRow } from '@pond/sdk'
import type { CategoryView } from '@pond/shared'
import { createTestPad } from '@pond/sdk/testing'
import { describe, expect, it } from 'vitest'
import { padModule } from './index'

const cat = (id: string, name: string, kind: CategoryView['kind'] = 'expense'): CategoryView => ({
  id,
  spaceId: 'space-1',
  parentId: null,
  name,
  kind,
  taxLine: null,
  sortOrder: 0,
  archivedAt: null,
})
const categories = [
  cat('groceries', 'Groceries'),
  cat('dining', 'Dining'),
  cat('pay', 'Paycheck', 'income'),
  cat('xfer', 'Transfer', 'transfer'),
]

/** A fake `splits.sum` that returns fixed rows and remembers what it was asked. */
function fakeCore(rows: SplitSumRow[], extra: Partial<ScopedCore> = {}) {
  const asked: { from: string; to: string }[] = []
  const core: Partial<ScopedCore> = {
    categories: { list: async () => categories },
    splits: {
      sum: async (o) => {
        asked.push({ from: o.from, to: o.to })
        return rows
      },
    },
    ...extra,
  }
  return { core, asked }
}
const spend = (categoryId: string, cents: number): SplitSumRow => ({
  categoryId,
  kind: 'expense',
  month: null,
  cents: -cents,
  count: 1,
})

type Budget = {
  lines: { categoryId: string; budgetedCents: number; spentCents: number; leftCents: number }[]
  available: { id: string }[]
  totals: { budgetedCents: number; spentCents: number; leftCents: number }
}

describe('Personal Finance pad: budgets', () => {
  /**
   * Function: PUT /budget then GET /budget
   * Inputs:   Groceries budget $400 from 2030-06; $250 spent on Groceries in June; $30 on Dining (not budgeted)
   * Expected: one line (Groceries: 400 budgeted, 250 spent, 150 left); Dining is offered as available;
   *           totals match; the spending query covered exactly June 1 to June 30
   */
  it('shows budgeted, spent and left for each budgeted category', async () => {
    const { core, asked } = fakeCore([spend('groceries', 25000), spend('dining', 3000)])
    const t = await createTestPad(padModule, { core })
    const put = await t.call('PUT', '/budget', {
      body: { month: '2030-06', items: [{ categoryId: 'groceries', amountCents: 40000 }] },
    })
    expect(put.status).toBe(200)
    const r = await t.call('GET', '/budget', { role: 'viewer', query: { month: '2030-06' } })
    const b = r.body as Budget
    expect(b.lines).toEqual([
      expect.objectContaining({
        categoryId: 'groceries',
        budgetedCents: 40000,
        spentCents: 25000,
        leftCents: 15000,
      }),
    ])
    expect(b.available.map((c) => c.id)).toEqual(['dining'])
    expect(b.totals).toEqual({ budgetedCents: 40000, spentCents: 25000, leftCents: 15000 })
    expect(asked).toEqual([{ from: '2030-06-01', to: '2030-06-30' }])
  })

  /**
   * Function: GET /budget (over budget, refunds)
   * Inputs:   $300 budget; $350 spent, then a month where a $20 refund leaves net -$20 spending
   * Expected: left is -5000 when over (the page says "over"); a net refund counts as negative spending
   */
  it('goes negative when over budget and counts refunds against spending', async () => {
    let rows = [spend('groceries', 35000)]
    const core: Partial<ScopedCore> = {
      categories: { list: async () => categories },
      splits: { sum: async () => rows },
    }
    const t = await createTestPad(padModule, { core })
    await t.call('PUT', '/budget', {
      body: { month: '2030-06', items: [{ categoryId: 'groceries', amountCents: 30000 }] },
    })
    const over = await t.call('GET', '/budget', { role: 'viewer', query: { month: '2030-06' } })
    expect((over.body as Budget).lines[0]!.leftCents).toBe(-5000)
    rows = [{ ...spend('groceries', 0), cents: 2000 }]
    const refund = await t.call('GET', '/budget', { role: 'viewer', query: { month: '2030-06' } })
    expect((refund.body as Budget).lines[0]!.spentCents).toBe(-2000)
  })

  /**
   * Function: budgets carrying forward, and changing from a month on
   * Inputs:   $400 from June; raise to $500 from August; then ask for May, June, July, August, September
   * Expected: May not tracked; June and July 400; August and September 500 (the June row is untouched)
   */
  it('carries an amount forward until it is changed', async () => {
    const t = await createTestPad(padModule, { core: fakeCore([]).core })
    const set = (month: string, amountCents: number) =>
      t.call('PUT', '/budget', {
        body: { month, items: [{ categoryId: 'groceries', amountCents }] },
      })
    await set('2030-06', 40000)
    await set('2030-08', 50000)
    const left = async (month: string) =>
      ((await t.call('GET', '/budget', { role: 'viewer', query: { month } })).body as Budget)
        .lines[0]?.budgetedCents
    expect(await left('2030-05')).toBeUndefined()
    expect(await left('2030-06')).toBe(40000)
    expect(await left('2030-07')).toBe(40000)
    expect(await left('2030-08')).toBe(50000)
    expect(await left('2030-09')).toBe(50000)
  })

  /**
   * Function: GET /budget with more stored budget rows than one page (1000)
   * Inputs:   1,001 rows for Groceries, one per year from 2000, each with a different amount; ask for year 3000
   * Expected: the newest row's amount is used (none were dropped by paging)
   */
  it('reads every stored budget row, not just the first page', async () => {
    const t = await createTestPad(padModule, { core: fakeCore([]).core })
    await t.table('budgets').insertMany(
      Array.from({ length: 1001 }, (_, i) => ({
        category_id: 'groceries',
        month: `${2000 + i}-01`,
        amount_cents: 100 + i,
      })),
    )
    const r = await t.call('GET', '/budget', { role: 'viewer', query: { month: '3000-01' } })
    expect((r.body as Budget).lines[0]!.budgetedCents).toBe(1100)
  })

  /**
   * Function: PUT /budget with amount 0 ("stop tracking")
   * Inputs:   $400 from June, then 0 from August; separately a brand-new category set to 0
   * Expected: tracked in July, not in August; a never-tracked category set to 0 leaves no row stored
   */
  it('stops tracking a category from a month on, without leaving junk rows', async () => {
    const t = await createTestPad(padModule, { core: fakeCore([]).core })
    const set = (month: string, categoryId: string, amountCents: number) =>
      t.call('PUT', '/budget', { body: { month, items: [{ categoryId, amountCents }] } })
    await set('2030-06', 'groceries', 40000)
    await set('2030-08', 'groceries', 0)
    const lines = async (month: string) =>
      ((await t.call('GET', '/budget', { role: 'viewer', query: { month } })).body as Budget).lines
    expect(await lines('2030-07')).toHaveLength(1)
    expect(await lines('2030-08')).toHaveLength(0)
    await set('2030-06', 'dining', 0)
    expect(await t.table('budgets').count({ category_id: 'dining' })).toBe(0)
  })

  /**
   * Function: PUT /budget validation and roles
   * Inputs:   a viewer; an income category; a transfer category; a made-up id; a negative amount; a bad month
   * Expected: 403; 400 invalid_category x3; 400 invalid_input x2; nothing stored
   */
  it('only budgets real expense categories, for editors', async () => {
    const t = await createTestPad(padModule, { core: fakeCore([]).core })
    const put = (body: unknown, role: 'viewer' | 'editor' = 'editor') =>
      t.call('PUT', '/budget', { role, body })
    const item = (categoryId: string, amountCents = 100) => ({
      month: '2030-06',
      items: [{ categoryId, amountCents }],
    })
    expect((await put(item('groceries'), 'viewer')).status).toBe(403)
    for (const id of ['pay', 'xfer', 'nope'])
      expect((await put(item(id))).body).toMatchObject({ error: 'invalid_category' })
    expect((await put(item('groceries', -1))).status).toBe(400)
    expect((await put({ ...item('groceries'), month: '2030-6' })).status).toBe(400)
    expect(await t.table('budgets').count()).toBe(0)
  })

  /**
   * Function: GET /budget/suggest
   * Inputs:   for July 2030, three months of spending: Groceries $1,203.00 (avg $401), Dining $100 (avg $33),
   *           a tiny $0.50 category; income and transfers are never offered
   * Expected: suggestions are Groceries 40100 then Dining 3300 (largest first); the tiny one rounds to
   *           $0 and is left out; the query covered April 1 to June 30; nothing is saved
   */
  it('suggests a budget from the last three months without saving it', async () => {
    const small = cat('tiny', 'Tiny')
    const { core, asked } = fakeCore([
      spend('groceries', 120300),
      spend('dining', 10000),
      spend('tiny', 50),
    ])
    core.categories = { list: async () => [...categories, small] }
    const t = await createTestPad(padModule, { core })
    const r = await t.call('GET', '/budget/suggest', {
      role: 'viewer',
      query: { month: '2030-07' },
    })
    expect((r.body as { suggestions: unknown[] }).suggestions).toEqual([
      { categoryId: 'groceries', name: 'Groceries', amountCents: 40100 },
      { categoryId: 'dining', name: 'Dining', amountCents: 3300 },
    ])
    expect(asked).toEqual([{ from: '2030-04-01', to: '2030-06-30' }])
    expect(await t.table('budgets').count()).toBe(0)
  })

  /**
   * Function: GET /transactions/:id (panel on a transaction)
   * Inputs:   a June transaction with splits in Groceries (budgeted) and Dining (not budgeted); an unknown id
   * Expected: one line for Groceries with what is left in June; 404 for the unknown id
   */
  it('shows what is left in the budget for a transaction’s categories', async () => {
    const txn = {
      kind: 'full',
      id: 'tx-1',
      date: '2030-06-12',
      splits: [{ categoryId: 'groceries' }, { categoryId: 'dining' }, { categoryId: null }],
    } as unknown as PadTransaction
    const { core } = fakeCore([spend('groceries', 25000)], {
      transactions: {
        list: async () => ({ transactions: [], total: 0 }),
        get: async (id) => (id === 'tx-1' ? txn : null),
      },
    })
    const t = await createTestPad(padModule, { core })
    await t.call('PUT', '/budget', {
      body: { month: '2030-06', items: [{ categoryId: 'groceries', amountCents: 40000 }] },
    })
    const r = await t.call('GET', '/transactions/tx-1', { role: 'viewer' })
    expect(r.body).toMatchObject({
      month: '2030-06',
      lines: [{ categoryId: 'groceries', leftCents: 15000 }],
    })
    expect((await t.call('GET', '/transactions/nope', { role: 'viewer' })).status).toBe(404)
  })
})

describe('Personal Finance pad: goals', () => {
  const account = (id: string, name: string, extra = {}) => ({
    id,
    name,
    nickname: null,
    institutionName: null,
    type: 'savings',
    currency: 'USD',
    isManual: false,
    includeInNetWorth: true,
    hidden: false,
    lastFour: null,
    archived: false,
    balanceCents: null,
    balanceDate: null,
    ...extra,
  })
  const accountsCore = fakeCore([], {
    accounts: {
      list: async () => [
        account('sav', 'Savings'),
        account('old', 'Closed', { archived: true }),
        account('hid', 'Hidden', { hidden: true }),
      ],
    },
    balances: {
      latest: async () => [{ accountId: 'sav', balanceCents: 80000, date: '2030-06-01' }],
      history: async () => [],
    },
  }).core

  /**
   * Function: POST /goals, POST /goals/:id/contributions, GET /goals (money I add myself)
   * Inputs:   a $1,000 goal; contributions of $300 and $200, then -$50 taken back out
   * Expected: saved 45000, 45 percent, not reached; contributions listed newest date first
   */
  it('adds up contributions for a goal that follows no account', async () => {
    const t = await createTestPad(padModule, { core: accountsCore })
    const id = (
      (await t.call('POST', '/goals', { body: { name: 'Trip', targetCents: 100000 } })).body as {
        id: string
      }
    ).id
    for (const [amountCents, date] of [
      [30000, '2030-05-01'],
      [20000, '2030-06-01'],
      [-5000, '2030-06-10'],
    ] as const)
      expect(
        (await t.call('POST', `/goals/${id}/contributions`, { body: { amountCents, date } }))
          .status,
      ).toBe(200)
    const g = (
      (await t.call('GET', '/goals', { role: 'viewer' })).body as {
        goals: Record<string, unknown>[]
      }
    ).goals[0]!
    expect(g).toMatchObject({ name: 'Trip', savedCents: 45000, percent: 45, reached: false })
    expect((g.contributions as { date: string }[]).map((c) => c.date)).toEqual([
      '2030-06-10',
      '2030-06-01',
      '2030-05-01',
    ])
  })

  /**
   * Function: goals linked to an account
   * Inputs:   a goal linked to Savings (balance $800) with a $1,000 target; a contribution attempt on it;
   *           a goal linked to an account that is not in this Space
   * Expected: saved 80000 and 80 percent from the balance; the contribution is refused 409 linked_goal;
   *           the unknown account is refused 400 invalid_account
   */
  it('takes progress from an account balance and refuses hand-added money', async () => {
    const t = await createTestPad(padModule, { core: accountsCore })
    const id = (
      (
        await t.call('POST', '/goals', {
          body: { name: 'Fund', targetCents: 100000, accountId: 'sav' },
        })
      ).body as { id: string }
    ).id
    const g = (
      (await t.call('GET', '/goals', { role: 'viewer' })).body as {
        goals: Record<string, unknown>[]
      }
    ).goals[0]!
    expect(g).toMatchObject({
      savedCents: 80000,
      percent: 80,
      accountName: 'Savings',
      contributions: [],
    })
    const add = await t.call('POST', `/goals/${id}/contributions`, {
      body: { amountCents: 100, date: '2030-06-01' },
    })
    expect(add.body).toMatchObject({ error: 'linked_goal' })
    const bad = await t.call('POST', '/goals', {
      body: { name: 'X', targetCents: 100, accountId: 'elsewhere' },
    })
    expect(bad.body).toMatchObject({ error: 'invalid_account' })
  })

  /**
   * Function: GET /accounts
   * Inputs:   accounts Savings, a closed one and a hidden one
   * Expected: only Savings is offered for a goal
   */
  it('offers only open, visible accounts', async () => {
    const t = await createTestPad(padModule, { core: accountsCore })
    const r = await t.call('GET', '/accounts', { role: 'viewer' })
    expect(r.body).toEqual({ accounts: [{ id: 'sav', name: 'Savings' }] })
  })

  /**
   * Function: PATCH and DELETE /goals/:id, DELETE contribution
   * Inputs:   rename a goal and change its date; patch with nothing; unknown ids; delete a goal that has contributions
   * Expected: changes saved; 400 nothing_to_change; 404 for unknown ids; the goal and its contributions are gone
   */
  it('edits and deletes goals and contributions', async () => {
    const t = await createTestPad(padModule, { core: accountsCore })
    const id = (
      (await t.call('POST', '/goals', { body: { name: 'Trip', targetCents: 100000 } })).body as {
        id: string
      }
    ).id
    const c = (
      (
        await t.call('POST', `/goals/${id}/contributions`, {
          body: { amountCents: 500, date: '2030-06-01' },
        })
      ).body as { id: string }
    ).id
    expect(
      (
        await t.call('PATCH', `/goals/${id}`, {
          body: { name: 'Holiday', targetDate: '2031-01-01' },
        })
      ).status,
    ).toBe(200)
    expect(await t.table('goals').findOne({ id })).toMatchObject({
      name: 'Holiday',
      target_date: '2031-01-01',
    })
    expect((await t.call('PATCH', `/goals/${id}`, { body: {} })).body).toMatchObject({
      error: 'nothing_to_change',
    })
    expect((await t.call('PATCH', '/goals/nope', { body: { name: 'x' } })).status).toBe(404)
    expect((await t.call('DELETE', `/goals/${id}/contributions/nope`)).status).toBe(404)
    expect((await t.call('DELETE', `/goals/${id}/contributions/${c}`)).status).toBe(200)
    await t.call('POST', `/goals/${id}/contributions`, {
      body: { amountCents: 500, date: '2030-06-02' },
    })
    expect((await t.call('DELETE', `/goals/${id}`)).status).toBe(200)
    expect(await t.table('goals').count()).toBe(0)
    expect(await t.table('contributions').count()).toBe(0)
  })

  /**
   * Function: goal validation and roles
   * Inputs:   a viewer creating; an empty name; a zero target; a date of 2030-02-30; a zero contribution
   * Expected: 403; then 400 each; nothing stored
   */
  it('validates goals before saving anything', async () => {
    const t = await createTestPad(padModule, { core: accountsCore })
    const post = (body: unknown, role: 'viewer' | 'editor' = 'editor') =>
      t.call('POST', '/goals', { role, body })
    expect((await post({ name: 'a', targetCents: 100 }, 'viewer')).status).toBe(403)
    expect((await post({ name: ' ', targetCents: 100 })).status).toBe(400)
    expect((await post({ name: 'a', targetCents: 0 })).status).toBe(400)
    expect((await post({ name: 'a', targetCents: 100, targetDate: '2030-02-30' })).status).toBe(400)
    const id = ((await post({ name: 'a', targetCents: 100 })).body as { id: string }).id
    const zero = await t.call('POST', `/goals/${id}/contributions`, {
      body: { amountCents: 0, date: '2030-06-01' },
    })
    expect(zero.status).toBe(400)
    expect(await t.table('contributions').count()).toBe(0)
  })
})
