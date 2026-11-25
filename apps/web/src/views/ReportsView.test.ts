import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '../api'
import { usePadsStore } from '../stores/pads'
import { useSpacesStore } from '../stores/spaces'
import { mountWithVuetify } from '../testing/mountWithVuetify'
import ReportsView from './ReportsView.vue'

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
}))

const cashFlow = {
  months: [{ month: '2030-01', inCents: 300000, outCents: 45000, netCents: 255000 }],
  totals: { inCents: 300000, outCents: 45000, netCents: 255000 },
  uncategorizedCount: 2,
  otherCurrencyAccounts: 1,
}

async function open(at = '/reports') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/reports', component: ReportsView },
      { path: '/:any(.*)', component: { template: '<div/>' } },
    ],
  })
  await router.push(at)
  const w = mountWithVuetify(ReportsView, { global: { plugins: [router] } })
  await flushPromises()
  return { w, router }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path.includes('/cash-flow')) return cashFlow
    if (path.includes('/spending'))
      return {
        from: 'x',
        to: 'y',
        totalCents: 8500,
        otherCurrencyAccounts: 0,
        lines: [
          { categoryId: 'g', name: 'Groceries', cents: 7500 },
          { categoryId: null, name: 'No category', cents: 2500 },
          { categoryId: 'd', name: 'Dining', cents: -1500 },
        ],
      }
    return { points: [], accounts: [], otherCurrencyAccounts: 0 }
  }) as typeof api)
  const spaces = useSpacesStore()
  spaces.spaces = [{ id: 's1', name: 'Home', type: 'personal', currency: 'USD', role: 'viewer' }]
})

describe('the Reports page', () => {
  /**
   * Function: the default report
   * Inputs:   open /reports with a fake cash flow that has 2 uncategorized amounts and 1 account in
   *           another currency
   * Expected: cash flow is asked for the active Space; totals, the legend and a table row show;
   *           both things the report assumes or leaves out are said
   */
  it('opens on cash flow and says what it assumed', async () => {
    const { w } = await open()
    expect(vi.mocked(api).mock.calls[0]![0]).toMatch(
      /^\/api\/spaces\/s1\/reports\/cash-flow\?from=\d{4}-\d{2}&to=\d{4}-\d{2}$/,
    )
    const text = w.text().replace(/\s+/g, ' ')
    expect(text).toContain('Money in')
    expect(text).toContain('$3,000.00')
    expect(text).toContain('2 amount(s) have no category yet')
    expect(text).toContain('1 account(s) in another currency are not included')
    expect(w.find('[role="listitem"]').attributes('aria-label')).toContain('money out $450.00')
  })

  /**
   * Function: the spending report, chosen by the address
   * Inputs:   open /reports?report=spending
   * Expected: only the spending report is requested; shares are of spending only (75% and 25%);
   *           the refund line is labeled instead of given a share
   */
  it('shows the report named in the address, with shares of real spending', async () => {
    const { w } = await open('/reports?report=spending')
    const paths = vi.mocked(api).mock.calls.map((c) => c[0] as string)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toContain('/reports/spending?from=')
    const rows = w.findAll('tbody tr').map((r) => r.text().replace(/\s+/g, ' '))
    expect(rows[0]).toContain('75%')
    expect(rows[1]).toContain('25%')
    expect(rows[2]).toContain('refunds')
  })

  /**
   * Function: "From your apps"
   * Inputs:   no apps running; then the Business and Personal apps running here
   * Expected: no section without apps; with them, each app's report is listed with the app's name
   *           and links to its page
   */
  it('lists reports from the apps running in the Space', async () => {
    const { w } = await open()
    expect(w.text()).not.toContain('From your apps')
    usePadsStore().enabled = [
      { id: 'business', name: 'Business Manager', version: '1.0.0' },
      { id: 'personal', name: 'Personal Finance', version: '1.0.0' },
    ]
    await flushPromises()
    expect(w.text()).toContain('From your apps')
    expect(w.text()).toContain('Profit and loss and tax summary')
    expect(w.text()).toContain('Business Manager')
    const links = w.findAll('a').map((a) => a.attributes('href'))
    expect(links).toEqual(expect.arrayContaining(['/p/business/reports', '/p/personal/budget']))
  })
})
