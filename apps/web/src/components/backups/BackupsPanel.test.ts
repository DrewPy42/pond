import type { BackupView } from '@pond/shared'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VSwitch } from 'vuetify/components'
import { mountWithVuetify } from '../../testing/mountWithVuetify'
import BackupsPanel from './BackupsPanel.vue'

// The network is replaced by a mock: these tests check what the screen shows and sends.
const apiMock = vi.fn()
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: (...a: unknown[]) => apiMock(...a),
}))

const view = (over: Partial<BackupView> = {}): BackupView => ({
  passphraseSet: true,
  schedule: { enabled: false, frequency: 'daily', time: '02:00', weekday: 0 },
  keep: 14,
  folder: { path: '/backups', available: true, enabled: false, connected: false },
  lastFolderBackupAt: null,
  lastDownloadAt: null,
  running: false,
  restorePending: false,
  warnings: [],
  ...over,
})

async function show(v: BackupView) {
  apiMock.mockResolvedValueOnce(v)
  const wrapper = mountWithVuetify(BackupsPanel)
  await flushPromises()
  const scheduleSwitch = () =>
    wrapper.findAllComponents(VSwitch).find((s) => s.props('label') === 'Back up automatically')
  const button = (text: string) => wrapper.findAll('button').find((b) => b.text() === text)!
  return { wrapper, scheduleSwitch, button }
}

describe('<BackupsPanel />', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    apiMock.mockReset()
  })

  /**
   * Inputs:   an ordinary install with no destination turned on
   * Expected: no online storage anywhere; the screen says a backup at home won't survive a fire
   *           or theft; no schedule is offered yet
   */
  it('offers downloads and the folder, and says to keep a copy elsewhere', async () => {
    const { wrapper, scheduleSwitch } = await show(view())
    expect(wrapper.text()).not.toMatch(/online storage/i)
    expect(wrapper.text()).toContain("won't survive a fire or theft")
    expect(scheduleSwitch()).toBeUndefined()
  })

  /**
   * Inputs:   a schedule that is on with the folder off and no folder set up, then "Back up
   *           automatically" switched off and Save
   * Expected: the warning shows and the switch is there to turn off; saving sends the schedule
   *           as off
   */
  it('lets a schedule with nowhere to save be turned off', async () => {
    const stuck = view({
      schedule: { enabled: true, frequency: 'daily', time: '02:00', weekday: 0 },
      folder: { path: null, available: false, enabled: false, connected: false },
      warnings: [{ kind: 'no_destination' }],
    })
    const { wrapper, scheduleSwitch, button } = await show(stuck)
    expect(wrapper.text()).toContain("there's nowhere to save them")
    expect(button('Save').attributes('disabled')).toBeDefined()
    scheduleSwitch()!.vm.$emit('update:modelValue', false)
    await flushPromises()
    apiMock.mockResolvedValueOnce(view())
    await button('Save').trigger('click')
    await flushPromises()
    expect(apiMock.mock.calls.at(-1)![1].body.schedule.enabled).toBe(false)
  })
})
