import { describe, expect, it } from 'vitest'
import { bootstrapAdmin, createUser, makeEnv } from '../testing/harness.js'

/**
 * The report routes over HTTP. Who may reach them is also covered by the permission suite,
 * which finds every Space route automatically.
 */
describe('core report routes', () => {
  async function world() {
    const env = makeEnv()
    const admin = await bootstrapAdmin(env)
    const val = await createUser(env, admin, 'val', '10.5.0.1')
    const id = (await admin.client.post('/api/spaces', { name: 'Home', type: 'personal' })).body
      .space.id as string
    await admin.client.put(`/api/spaces/${id}/members/${val.id}`, { role: 'viewer' })
    return { env, val, base: `/api/spaces/${id}/reports` }
  }

  /**
   * Function: GET reports/cash-flow, spending, net-worth
   * Inputs:   a viewer asks each with good parameters
   * Expected: 200 with an empty but complete report
   */
  it('lets a viewer read all three', async () => {
    const w = await world()
    const get = async (path: string) => (await w.val.client.get(`${w.base}/${path}`)).body
    expect((await get('cash-flow?from=2030-01&to=2030-03')).months).toHaveLength(3)
    expect(await get('spending?from=2030-01-01&to=2030-01-31')).toMatchObject({
      lines: [],
      totalCents: 0,
    })
    expect(await get('net-worth?today=2030-01-31')).toMatchObject({ points: [], accounts: [] })
  })

  /**
   * Function: report parameter checks
   * Inputs:   missing and malformed values, a start after the end, more than 10 years, month 13,
   *           an impossible date, 121 months of net worth
   * Expected: 400 invalid_input for each
   */
  it('refuses ranges that are wrong or too large', async () => {
    const w = await world()
    for (const path of [
      'cash-flow',
      'cash-flow?from=2030-02&to=2030-01',
      'cash-flow?from=2019-01&to=2030-01',
      'cash-flow?from=2030-13&to=2030-13',
      'spending?from=2030-02-30&to=2030-03-01',
      'spending?from=2030-03-02&to=2030-03-01',
      'net-worth',
      'net-worth?today=2030-01-31&months=121',
    ]) {
      const r = await w.val.client.get(`${w.base}/${path}`)
      expect([r.status, r.body.error], path).toEqual([400, 'invalid_input'])
    }
  })
})
