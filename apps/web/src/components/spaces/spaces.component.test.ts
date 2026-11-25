/* eslint-disable vue/one-component-per-file -- small stand-ins for dialogs and menus */
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import { useSpacesStore } from '../../stores/spaces'
import { mountWithVuetify } from '../../testing/mountWithVuetify'
import FirstSpacePrompt from './FirstSpacePrompt.vue'
import MembersDialog from './MembersDialog.vue'
import SpacesPanel from './SpacesPanel.vue'
import { ApiError } from '../../api'
import NewSpaceDialog from './NewSpaceDialog.vue'

vi.mock('../../api', async (original) => ({
  ...(await original<typeof import('../../api')>()),
  api: vi.fn(),
}))

/** Dialogs are drawn in place, so their contents can be found. */
const VDialog = defineComponent({
  props: { modelValue: Boolean },
  template: '<div v-if="modelValue"><slot /></div>',
})
const stubs = { VDialog }

const signIn = (isAdmin: boolean) => {
  useAuthStore().user = {
    id: 'me',
    username: 'me',
    displayName: 'Me',
    isAdmin,
    totpEnabled: true,
  }
}
const space = { id: 's1', name: 'Home', type: 'personal', currency: 'USD', role: 'owner' } as const

/** A fake server: remembers each call and answers by path. */
function fakeServer(answers: Record<string, unknown> = {}) {
  const calls: { path: string; method: string; body?: unknown }[] = []
  vi.mocked(api).mockImplementation((async (
    path: string,
    o?: { method?: string; body?: unknown },
  ) => {
    const method = o?.method ?? 'GET'
    calls.push({ path, method, ...(o?.body === undefined ? {} : { body: o.body }) })
    return answers[`${method} ${path}`] ?? {}
  }) as typeof api)
  return calls
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(api).mockReset()
})

describe('FirstSpacePrompt', () => {
  /**
   * Function: what someone with no Space sees
   * Inputs:   the administrator; an ordinary user
   * Expected: the administrator is offered "New Space"; the user is told to ask for access and has
   *           no button
   */
  it('offers the administrator a Space to create, and tells others whom to ask', () => {
    signIn(true)
    const admin = mountWithVuetify(FirstSpacePrompt, { global: { stubs } })
    expect(admin.text()).toContain('Create your first Space')
    expect(admin.find('button').text()).toContain('New Space')

    signIn(false)
    const other = mountWithVuetify(FirstSpacePrompt, { global: { stubs } })
    expect(other.text()).toContain('Ask your administrator')
    expect(other.find('button').exists()).toBe(false)
  })
})

describe('NewSpaceDialog', () => {
  /**
   * Function: creating a Space
   * Inputs:   the administrator types "Studio" and submits (fake server returns id "s9")
   * Expected: POST /api/spaces with the name, kind and the admin as owner; the list is reloaded and
   *           the new Space becomes active
   */
  it('creates the Space with the creator as owner and switches to it', async () => {
    signIn(true)
    const calls = fakeServer({
      'POST /api/spaces': { space: { id: 's9' } },
      'GET /api/spaces': { spaces: [space, { ...space, id: 's9', name: 'Studio' }] },
    })
    const w = mountWithVuetify(NewSpaceDialog, {
      props: { modelValue: false },
      global: { stubs },
    })
    await w.setProps({ modelValue: true })
    await w.find('input').setValue('Studio')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(calls[0]).toEqual({
      path: '/api/spaces',
      method: 'POST',
      body: { name: 'Studio', type: 'personal', ownerUserId: 'me' },
    })
    expect(useSpacesStore().active?.id).toBe('s9')
  })
})

describe('MembersDialog', () => {
  const members = [
    { userId: 'me', username: 'me', displayName: 'Me', role: 'owner' },
    { userId: 'u2', username: 'sam', displayName: 'Sam', role: 'viewer' },
  ]
  async function openAs(isAdmin: boolean) {
    signIn(isAdmin)
    const calls = fakeServer({
      'GET /api/spaces/s1/members': { members },
      'GET /api/users': { users: [] },
    })
    const w = mountWithVuetify(MembersDialog, {
      props: { modelValue: false, space },
      global: { stubs },
    })
    await w.setProps({ modelValue: true })
    await flushPromises()
    return { w, calls }
  }

  /**
   * Function: opening the dialog, and adding by username (an owner who isn't the administrator)
   * Inputs:   open it; type "pat" and submit
   * Expected: the user list is never requested; "pat" is sent to POST .../members as a viewer; the
   *           member list is then reloaded
   */
  it('lets an owner add by username without ever asking for the user list', async () => {
    const { w, calls } = await openAs(false)
    expect(w.text()).toContain('Sam')
    await w.find('input[autocomplete="off"]').setValue('pat')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(calls.map((c) => c.path)).not.toContain('/api/users')
    expect(calls.at(-2)).toEqual({
      path: '/api/spaces/s1/members',
      method: 'POST',
      body: { username: 'pat', role: 'viewer' },
    })
    expect(calls.at(-1)).toEqual({ path: '/api/spaces/s1/members', method: 'GET' })
  })

  /**
   * Function: opening the dialog as the administrator; the only owner's controls
   * Inputs:   members "Me" (the only owner) and "Sam" (viewer)
   * Expected: the user list is requested; the only owner can't be removed, Sam can
   */
  it('gives the administrator the user list and protects the only owner', async () => {
    const { w, calls } = await openAs(true)
    expect(calls.map((c) => c.path)).toContain('/api/users')
    expect(w.find('button[aria-label="Remove Me"]').attributes('disabled')).toBeDefined()
    expect(w.find('button[aria-label="Remove Sam"]').attributes('disabled')).toBeUndefined()
  })
})

describe('SpacesPanel: removing a Space', () => {
  const VMenu = defineComponent({
    template: '<div><slot name="activator" :props="{}" /><slot /></div>',
  })

  async function panel(isAdmin: boolean) {
    signIn(isAdmin)
    useSpacesStore().spaces = [{ ...space }]
    const calls = fakeServer({ 'GET /api/spaces/archived': { spaces: [] } })
    const w = mountWithVuetify(SpacesPanel, { global: { stubs: { ...stubs, VMenu } } })
    await flushPromises()
    return { w, calls }
  }

  /**
   * Function: who is offered archive and delete
   * Inputs:   an owner who isn't the administrator
   * Expected: no "More options" button, and the archived list is never requested
   */
  it('offers it to the administrator only', async () => {
    const { w, calls } = await panel(false)
    expect(w.find('button[aria-label="More options for Home"]').exists()).toBe(false)
    expect(calls.map((c) => c.path)).not.toContain('/api/spaces/archived')
  })

  /**
   * Function: deleting a Space that has records
   * Inputs:   the administrator chooses Delete and confirms; the fake server answers 409
   *           space_not_empty
   * Expected: DELETE is sent; the dialog stays open and suggests archiving instead
   */
  it('keeps the dialog open and explains when a Space is not empty', async () => {
    const { w } = await panel(true)
    const item = w.findAll('.v-list-item').find((i) => i.text() === 'Delete')!
    await item.trigger('click')
    vi.mocked(api).mockRejectedValueOnce(new ApiError(409, 'space_not_empty'))
    const confirmButton = w
      .findAll('button')
      .filter((b) => b.text() === 'Delete')
      .at(-1)!
    await confirmButton.trigger('click')
    await flushPromises()
    expect(vi.mocked(api).mock.calls.at(-1)).toEqual(['/api/spaces/s1', { method: 'DELETE' }])
    expect(w.text()).toContain('Delete Home for good?')
    expect(w.text()).toContain('Archive it instead')
  })
})
