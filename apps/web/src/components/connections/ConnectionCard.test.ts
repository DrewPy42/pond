import type { ConnectionView } from '@pond/shared'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VSelect } from 'vuetify/components'
import { useSpacesStore } from '../../stores/spaces'
import { mountWithVuetify } from '../../testing/mountWithVuetify'
import ConnectionCard from './ConnectionCard.vue'

// The network is replaced by a mock `api`: these tests check what the card shows and sends.
const apiMock = vi.fn()
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: (...a: unknown[]) => apiMock(...a),
}))

const connection = (over: Partial<ConnectionView> = {}): ConnectionView => ({
  id: 'c1',
  label: 'My bank',
  status: 'active',
  lastSyncedAt: null,
  lastError: null,
  accounts: [
    {
      id: 'a1',
      name: 'Everyday Checking',
      type: 'checking',
      currency: 'USD',
      institutionName: 'Test Bank',
      primarySpaceId: null,
      syncEnabled: false,
      hidden: true,
    },
  ],
  ...over,
})
const mountCard = (c: ConnectionView) => {
  const spaces = useSpacesStore()
  spaces.spaces = [
    { id: 'space-home', name: 'Home', type: 'personal', currency: 'USD', role: 'owner' },
  ]
  return mountWithVuetify(ConnectionCard, { props: { connection: c } })
}

describe('<ConnectionCard :connection />', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    apiMock.mockReset()
  })

  /**
   * Function: ConnectionCard (display)
   * Inputs:   an active connection never synced, with one unassigned account; then one with an
   *           error and a last-error message
   * Expected: shows "Connected", "Last synced: Never", the account name and the hint to choose a
   *           Space; the error one shows "Needs attention" and the message
   */
  it('shows status, accounts, and a hint for unassigned accounts', () => {
    const ok = mountCard(connection())
    expect(ok.text()).toContain('Connected')
    expect(ok.text()).toContain('Last synced: Never')
    expect(ok.text()).toContain('Everyday Checking')
    expect(ok.text()).toContain('Choose a Space for each account')
    const bad = mountCard(
      connection({ status: 'error', lastError: 'Please sign in to your bank again' }),
    )
    expect(bad.text()).toContain('Needs attention')
    expect(bad.text()).toContain('Please sign in to your bank again')
  })

  /**
   * Function: ConnectionCard (assigning a Space)
   * Inputs:   the admin picks "Home" for the account
   * Expected: sends PATCH /api/connections/c1/accounts/a1 with primarySpaceId "space-home", shows
   *           the "Use Sync now" notice, and tells the parent to refresh
   */
  it('saves a chosen Space and prompts to sync', async () => {
    apiMock.mockResolvedValue({})
    const w = mountCard(connection())
    await w.findComponent(VSelect).vm.$emit('update:modelValue', 'space-home')
    await flushPromises()
    expect(apiMock).toHaveBeenCalledWith('/api/connections/c1/accounts/a1', {
      method: 'PATCH',
      body: { primarySpaceId: 'space-home' },
    })
    expect(w.text()).toContain('Sync now')
    expect(w.emitted('changed')).toBeTruthy()
  })

  /**
   * Function: ConnectionCard (disconnect needs confirmation)
   * Inputs:   the Disconnect button clicked once, then again
   * Expected: the first click only asks "Click again to disconnect" and sends nothing; the second
   *           sends DELETE /api/connections/c1 and emits "removed"
   */
  it('asks for a second click before disconnecting', async () => {
    apiMock.mockResolvedValue({ ok: true })
    const w = mountCard(connection())
    const btn = () => w.findAll('button').find((b) => /disconnect/i.test(b.text()))!
    await btn().trigger('click')
    expect(apiMock).not.toHaveBeenCalled()
    expect(btn().text()).toContain('Click again')
    await btn().trigger('click')
    await flushPromises()
    expect(apiMock).toHaveBeenCalledWith('/api/connections/c1', { method: 'DELETE' })
    expect(w.emitted('removed')).toBeTruthy()
  })
})
