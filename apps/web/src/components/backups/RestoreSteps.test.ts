import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VCheckbox, VFileInput, VForm } from 'vuetify/components'
import { ApiError } from '../../api'
import { mountWithVuetify } from '../../testing/mountWithVuetify'
import RestoreSteps from './RestoreSteps.vue'

// The network is replaced by mocks: these tests check what the steps show and send.
const apiMock = vi.fn()
const uploadMock = vi.fn()
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: (...a: unknown[]) => apiMock(...a),
  apiUpload: (...a: unknown[]) => uploadMock(...a),
}))

const summary = {
  createdAt: '2026-01-01T00:00:00.000Z',
  pondVersion: '0.0.0',
  counts: { users: 2, spaces: 3, accounts: 4, transactions: 500, files: 6 },
  warnings: ['Mind this'],
}

describe('<RestoreSteps first-run />', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    apiMock.mockReset()
    uploadMock.mockReset()
  })

  /**
   * Function: RestoreSteps (check, then confirm)
   * Inputs:   a file, a wrong passphrase then the right one, then the checkbox
   * Expected: no code is asked for; the file is uploaded once, to the first-run routes; the
   *           summary and warning show; Restore is disabled until the box is ticked, then confirms
   *           with replaceEverything and shows that Pond is restarting
   */
  it('uploads once, shows the contents and needs an explicit tick to restore', async () => {
    uploadMock.mockResolvedValue({ uploadId: 'up1' })
    apiMock.mockRejectedValueOnce(new ApiError(400, 'wrong_passphrase', { message: 'Nope' }))
    const wrapper = mountWithVuetify(RestoreSteps, { props: { firstRun: true, pollMs: 60_000 } })
    const typed = wrapper.findAll('input').filter((i) => i.attributes('type') !== 'file')
    expect(typed).toHaveLength(1) // only the passphrase
    const passphrase = typed[0]
    await wrapper.findComponent(VFileInput).setValue(new File(['x'], 'a.pond'))
    await passphrase!.setValue('wrong')
    await wrapper.findComponent(VForm).trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('Nope')

    apiMock.mockResolvedValueOnce({ summary })
    await wrapper.findComponent(VForm).trigger('submit')
    await flushPromises()
    expect(uploadMock).toHaveBeenCalledTimes(1)
    expect(uploadMock.mock.calls[0]![0]).toBe('/api/setup/restore/upload')
    expect(wrapper.text()).toContain('Transactions: 500')
    expect(wrapper.text()).toContain('Mind this')
    expect(wrapper.text()).toContain('Everything now in Pond will be replaced')

    const restore = () => wrapper.findAll('button').find((b) => b.text() === 'Restore')!
    expect(restore().attributes('disabled')).toBeDefined()
    wrapper.findComponent(VCheckbox).vm.$emit('update:modelValue', true)
    await flushPromises()
    apiMock.mockResolvedValueOnce({ restarting: true })
    await restore().trigger('click')
    await flushPromises()
    expect(apiMock.mock.calls.at(-1)).toEqual([
      '/api/setup/restore/confirm',
      {
        method: 'POST',
        body: { uploadId: 'up1', replaceEverything: true },
      },
    ])
    expect(wrapper.text()).toContain('Pond is restarting')
    wrapper.unmount()
  })
})
