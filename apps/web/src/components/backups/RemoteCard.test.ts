import type { BackupView } from '@pond/shared'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountWithVuetify } from '../../testing/mountWithVuetify'
import RemoteCard from './RemoteCard.vue'

// The network is replaced by a mock `api`: these tests check what the card shows and sends.
const apiMock = vi.fn()
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: (...a: unknown[]) => apiMock(...a),
}))

const view = (remote: Partial<BackupView['remote']> = {}): BackupView => ({
  passphraseSet: true,
  schedule: { enabled: false, frequency: 'daily', time: '02:00', weekday: 0 },
  keep: 14,
  folder: { path: null, available: false, enabled: false, connected: false },
  remote: {
    available: true,
    configured: true,
    service: 'Dropbox',
    folder: 'Pond',
    enabled: true,
    paused: false,
    ...remote,
  },
  lastFolderBackupAt: null,
  lastRemoteBackupAt: null,
  lastDownloadAt: null,
  running: false,
  restorePending: false,
  warnings: [],
})
const buttons = (w: ReturnType<typeof mountWithVuetify>) => w.findAll('button').map((b) => b.text())

describe('<RemoteCard :view />', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    apiMock.mockReset()
  })

  /**
   * Function: RemoteCard (paused after a restore)
   * Inputs:   a paused Dropbox remote; then "Turn back on"
   * Expected: it explains the risk to the other copy's backups and offers no upload; turning it
   *           on sends the folder without any setup and passes the new view up
   */
  it('keeps a paused remote from uploading until it is turned back on', async () => {
    const next = view()
    apiMock.mockResolvedValue(next)
    const w = mountWithVuetify(RemoteCard, { props: { view: view({ paused: true }) } })
    expect(w.text()).toContain('another copy would delete its old backups')
    expect(buttons(w)).not.toContain('Back up to online storage')
    await w
      .findAll('button')
      .find((b) => b.text() === 'Turn back on')!
      .trigger('click')
    await flushPromises()
    expect(apiMock).toHaveBeenCalledWith('/api/backups/remote', {
      method: 'PUT',
      body: { folder: 'Pond', enabled: true },
    })
    expect(w.emitted('updated')).toEqual([[next]])
    w.unmount()
  })

  /**
   * Function: RemoteCard (no rclone)
   * Inputs:   an install without rclone and nothing set up
   * Expected: it says so, and set-up can't be started
   */
  it("can't be set up without rclone", () => {
    const w = mountWithVuetify(RemoteCard, {
      props: { view: view({ available: false, configured: false, enabled: false }) },
    })
    expect(w.text()).toContain("doesn't have rclone")
    const start = w.findAll('button').find((b) => b.text() === 'Set up online storage')!
    expect(start.attributes('disabled')).toBeDefined()
    w.unmount()
  })
})
