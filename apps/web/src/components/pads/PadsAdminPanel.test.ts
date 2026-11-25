import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../api'
import { usePadsStore } from '../../stores/pads'
import { mountWithVuetify } from '../../testing/mountWithVuetify'
import PadsAdminPanel from './PadsAdminPanel.vue'

vi.mock('../../api', async (original) => ({
  ...(await original<typeof import('../../api')>()),
  api: vi.fn(),
}))

const listing = (spaceIds: string[]) => ({
  pads: [
    {
      id: 'business',
      name: 'Business Manager',
      version: '1.0.0',
      author: 'x',
      description: null,
      spaceTypes: ['business'],
      permissions: [],
      touchesFinances: true,
      installed: true,
      state: 'running',
      problem: null,
      enabledSpaceIds: spaceIds,
    },
  ],
})

describe('PadsAdminPanel', () => {
  /**
   * Function: the "On in N Spaces" line
   * Inputs:   the panel loads with the app on nowhere; then the Space's list of running apps changes
   *           (as it does after the on/off switch), and the fake server now reports one Space
   * Expected: the panel asks again and shows "On in 1 Space" without a page reload
   */
  it('refreshes its counts when an app is switched on in a Space', async () => {
    setActivePinia(createPinia())
    vi.mocked(api).mockResolvedValueOnce(listing([]))
    const wrapper = mountWithVuetify(PadsAdminPanel, { global: { stubs: { FormDialog: true } } })
    await flushPromises()
    expect(wrapper.text().replace(/\s+/g, ' ')).toContain('On in 0 Spaces')

    vi.mocked(api).mockResolvedValueOnce(listing(['space-1']))
    usePadsStore().enabled = [{ id: 'business', name: 'Business Manager', version: '1.0.0' }]
    await flushPromises()
    expect(wrapper.text().replace(/\s+/g, ' ')).toContain('On in 1 Space')
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2)
  })
})
