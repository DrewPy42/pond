<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../../api'
import type { ManagedUser } from '../../composables/spaces'
import { useAction } from '../../composables/useAction'
import { useAuthStore } from '../../stores/auth'
import { FormDialog } from '../common'

/** For the administrator: the people who can sign in to this Pond. */
const auth = useAuthStore()
const { busy, error, run } = useAction()
const users = ref<ManagedUser[]>([])

async function load() {
  const r = await run(() => api<{ users: ManagedUser[] }>('/api/users'))
  if (r) users.value = r.users
}
onMounted(load)

// ----- add -----
const adding = ref(false)
const blank = () => ({ displayName: '', username: '', password: '', isAdmin: false })
const form = ref(blank())
const addAction = useAction()

function openAdd() {
  form.value = blank()
  addAction.error.value = ''
  adding.value = true
}
async function add() {
  const done = await addAction.run(
    async () => (await api('/api/users', { method: 'POST', body: form.value }), true),
  )
  if (done) {
    adding.value = false
    // The temporary password doesn't linger in the page.
    form.value = blank()
    await load()
  }
}

// ----- changes that deserve a second look -----
type Change = 'disable' | 'enable' | 'make_admin' | 'remove_admin'
const pending = ref<{ user: ManagedUser; change: Change } | null>(null)
const CHANGES: Record<
  Change,
  { menu: string; title: (n: string) => string; text: string; body: object }
> = {
  disable: {
    menu: 'Turn off sign-in',
    title: (n) => `Turn off sign-in for ${n}?`,
    text: 'They are signed out everywhere and can’t sign in until you turn it back on. Nothing is deleted.',
    body: { status: 'disabled' },
  },
  enable: {
    menu: 'Turn sign-in back on',
    title: (n) => `Let ${n} sign in again?`,
    text: 'They can sign in with the same password.',
    body: { status: 'active' },
  },
  make_admin: {
    menu: 'Make administrator',
    title: (n) => `Make ${n} an administrator?`,
    text: 'Administrators can see every Space, including all its money and private records, and manage users and banks.',
    body: { isAdmin: true },
  },
  remove_admin: {
    menu: 'Remove administrator',
    title: (n) => `Remove ${n} as an administrator?`,
    text: 'They will only see the Spaces they have been added to.',
    body: { isAdmin: false },
  },
}
const menuFor = (u: ManagedUser): Change[] => [
  u.isAdmin ? 'remove_admin' : 'make_admin',
  u.status === 'active' ? 'disable' : 'enable',
]
async function apply() {
  const p = pending.value
  if (!p) return
  pending.value = null
  await run(() => api(`/api/users/${p.user.id}`, { method: 'PATCH', body: CHANGES[p.change].body }))
  const problem = error.value
  await load()
  error.value = problem
}
</script>

<template>
  <div class="d-flex align-center mb-1 ga-3 flex-wrap">
    <h2 class="text-h6">Users</h2>
    <v-spacer />
    <v-btn color="primary" prepend-icon="mdi-account-plus-outline" @click="openAdd"
      >Add a user</v-btn
    >
  </div>
  <p class="text-body-2 text-medium-emphasis mb-3">
    People who can sign in to Pond. A new user sees nothing until you add them to a Space.
  </p>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>
  <v-card border flat>
    <v-list lines="two">
      <v-list-item v-for="u in users" :key="u.id">
        <v-list-item-title>
          {{ u.displayName }}
          <v-chip v-if="u.isAdmin" size="x-small" class="ml-2">Administrator</v-chip>
          <v-chip v-if="u.status === 'disabled'" size="x-small" color="warning" class="ml-2"
            >Sign-in off</v-chip
          >
        </v-list-item-title>
        <v-list-item-subtitle>{{ u.username }}</v-list-item-subtitle>
        <template #append>
          <span v-if="u.id === auth.user?.id" class="text-caption text-medium-emphasis">You</span>
          <v-menu v-else>
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                icon="mdi-dots-vertical"
                variant="text"
                :aria-label="`Options for ${u.displayName}`"
                :disabled="busy"
              />
            </template>
            <v-list density="compact">
              <v-list-item
                v-for="c in menuFor(u)"
                :key="c"
                :title="CHANGES[c].menu"
                @click="pending = { user: u, change: c }"
              />
            </v-list>
          </v-menu>
        </template>
      </v-list-item>
    </v-list>
  </v-card>

  <FormDialog
    v-model="adding"
    title="Add a user"
    submit-label="Add"
    :busy="addAction.busy.value"
    :error="addAction.error.value"
    :submit-disabled="!form.displayName.trim() || !form.username.trim() || !form.password"
    :max-width="460"
    @submit="add"
  >
    <v-text-field v-model="form.displayName" label="Name" maxlength="80" autofocus />
    <v-text-field
      v-model="form.username"
      label="Username"
      autocomplete="off"
      hint="3 to 32 letters, numbers, dots, dashes or underscores"
      persistent-hint
      class="mb-3"
    />
    <v-text-field
      v-model="form.password"
      label="Temporary password"
      type="password"
      autocomplete="new-password"
      hint="At least 12 characters. Ask them to change it after signing in."
      persistent-hint
      class="mb-2"
    />
    <v-checkbox v-model="form.isAdmin" label="Administrator" hide-details density="compact" />
    <p v-if="form.isAdmin" class="text-caption text-medium-emphasis">
      Administrators see every Space and manage users and banks. They must set up an authenticator
      app the first time they sign in.
    </p>
  </FormDialog>

  <v-dialog :model-value="!!pending" max-width="440" @update:model-value="pending = null">
    <v-card v-if="pending" :title="CHANGES[pending.change].title(pending.user.displayName)">
      <v-card-text>{{ CHANGES[pending.change].text }}</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="pending = null">Cancel</v-btn>
        <v-btn color="primary" @click="apply">Yes</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
