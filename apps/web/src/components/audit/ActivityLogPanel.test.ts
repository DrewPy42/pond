import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api'
import { mountWithVuetify } from '../../testing/mountWithVuetify'
import ActivityLogPanel from './ActivityLogPanel.vue'

// The network is replaced by a mock: these tests check what the screen shows and asks for.
const apiMock = vi.fn()
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: (...a: unknown[]) => apiMock(...a),
}))

const entry = (id: string, at: string, action = 'auth.login') => ({
  id,
  at,
  actorType: 'user',
  actorId: 'u1',
  action,
  targetType: null,
  targetId: null,
  spaceId: null,
  meta: null,
})
const AT = '2030-01-01T12:00:00.000Z'

/** Answers each address as the server would; `pages` are handed out in order. */
function server(pages: unknown[][]) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/users') return { users: [{ id: 'u1', displayName: 'Ann' }] }
    if (path.startsWith('/api/audit-log')) return { entries: pages.shift() ?? [] }
    if (path === '/api/lilypads') throw new ApiError(500, 'internal_error')
    return { spaces: [] }
  })
}
const asked = () =>
  apiMock.mock.calls.map((c) => c[0] as string).filter((p) => p.startsWith('/api/audit-log'))

async function mount(pageSize = 2) {
  const wrapper = mountWithVuetify(ActivityLogPanel, { props: { pageSize } })
  const button = (text: string) => wrapper.findAll('button').find((b) => b.text() === text)
  const press = async (text: string) => {
    await button(text)!.trigger('click')
    await flushPromises()
  }
  return { wrapper, button, press }
}

describe('<ActivityLogPanel />', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    apiMock.mockReset()
  })

  /**
   * Inputs:   the panel before and after "Show the activity log", with one name list failing
   * Expected: nothing is asked for until the button is pressed; then entries show in plain words
   *           with names, and a list that fails doesn't stop the log
   */
  it('loads only when asked, and shows plain words and names', async () => {
    server([[entry('e2', AT), entry('e1', AT, 'backup.downloaded')]])
    const { wrapper, press } = await mount()
    await flushPromises()
    expect(apiMock).not.toHaveBeenCalled()
    await press('Show the activity log')
    const lines = wrapper.findAll('li').map((l) => l.text())
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Signed in')
    expect(lines[0]).toContain('Ann')
    expect(lines[1]).toContain('Downloaded a backup')
    expect(asked()).toEqual(['/api/audit-log?limit=2'])
  })

  /**
   * Inputs:   two full pages and then a short one, two at a time
   * Expected: "Load more" asks to carry on from the last shown entry's time and id, adds to
   *           what is there, and goes away after a short page
   */
  it('loads more from the last entry, until there is no more', async () => {
    server([
      [entry('e5', AT), entry('e4', AT)],
      [entry('e3', AT), entry('e2', AT)],
      [entry('e1', AT)],
    ])
    const { wrapper, button, press } = await mount()
    await press('Show the activity log')
    await press('Load more')
    await press('Load more')
    expect(wrapper.findAll('li')).toHaveLength(5)
    expect(button('Load more')).toBeUndefined()
    expect(asked()[1]).toBe(
      '/api/audit-log?limit=2&before=2030-01-01T12%3A00%3A00.000Z&beforeId=e4',
    )
    expect(asked()[2]).toContain('beforeId=e2')
  })

  /**
   * Inputs:   Refresh after two pages
   * Expected: starts again from the newest, replacing the list
   */
  it('starts again on Refresh', async () => {
    server([[entry('e2', AT), entry('e1', AT)], [], [entry('e9', AT)]])
    const { wrapper, press } = await mount()
    await press('Show the activity log')
    await press('Load more')
    await press('Refresh')
    expect(wrapper.findAll('li')).toHaveLength(1)
    expect(asked().at(-1)).toBe('/api/audit-log?limit=2')
  })
})
