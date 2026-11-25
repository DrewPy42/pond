<script setup lang="ts">
import type { ConnectionAccountView, ConnectionView } from '@pond/shared'
import { computed, ref } from 'vue'
import { api } from '../../api'
import { useAction } from '../../composables/useAction'
import { useSpacesStore } from '../../stores/spaces'

/** One bank connection: its status, its accounts (with a Space for each), and sync controls. */
const props = defineProps<{ connection: ConnectionView }>()
const emit = defineEmits<{ changed: [connection?: ConnectionView]; removed: [] }>()

const spaces = useSpacesStore()
const { busy, error, run } = useAction()
const notice = ref('')
const confirmDisconnect = ref(false)

const spaceItems = computed(() => [
  { title: 'Not tracked', value: null },
  ...spaces.spaces.map((s) => ({ title: s.name, value: s.id })),
])
/** An account in a Space that isn't listed (it's archived) says so instead of showing an id. */
const itemsFor = (a: ConnectionAccountView) =>
  a.primarySpaceId && !spaces.spaces.some((s) => s.id === a.primarySpaceId)
    ? [...spaceItems.value, { title: 'In an archived Space', value: a.primarySpaceId }]
    : spaceItems.value
const status = computed(() => {
  switch (props.connection.status) {
    case 'active':
      return { text: 'Connected', color: 'secondary', icon: 'mdi-check-circle-outline' }
    case 'error':
      return { text: 'Needs attention', color: 'warning', icon: 'mdi-alert-outline' }
    default:
      return { text: 'Disconnected', color: undefined, icon: 'mdi-link-off' }
  }
})
const lastSynced = computed(() =>
  props.connection.lastSyncedAt
    ? new Date(props.connection.lastSyncedAt).toLocaleString()
    : 'Never',
)
const typeLabel = (t: string) => t.replace('_', ' ').replace(/^./, (c) => c.toUpperCase())
const live = computed(() => props.connection.status !== 'revoked')
const hasUnassigned = computed(() =>
  props.connection.accounts.some((a) => a.primarySpaceId === null),
)

async function assign(a: ConnectionAccountView, spaceId: string | null) {
  notice.value = ''
  const done = await run(() =>
    api(`/api/connections/${props.connection.id}/accounts/${a.id}`, {
      method: 'PATCH',
      body: { primarySpaceId: spaceId },
    }),
  )
  emit('changed') // refresh either way so a refused change snaps back
  if (done && spaceId) notice.value = 'Saved. Use "Sync now" to bring in its transactions.'
}

async function sync() {
  notice.value = ''
  const r = await run(() =>
    api<{
      summary: {
        ok: boolean
        error: string | null
        inserted: number
        updated: number
        removed: number
        newAccounts: number
        warnings: string[]
      }
      connection: ConnectionView
    }>(`/api/connections/${props.connection.id}/sync`, { method: 'POST', body: {} }),
  )
  if (!r) return
  const s = r.summary
  notice.value = s.ok
    ? `Synced: ${s.inserted} new, ${s.updated} updated, ${s.removed} removed.` +
      (s.newAccounts ? ` ${s.newAccounts} new account(s) found; choose a Space for them.` : '')
    : ''
  if (!s.ok && s.error) error.value = s.error
  emit('changed', r.connection)
}

async function refreshAccounts() {
  notice.value = ''
  const r = await run(() =>
    api<{ discovery: { added: number }; connection: ConnectionView }>(
      `/api/connections/${props.connection.id}/discover`,
      {
        method: 'POST',
        body: {},
      },
    ),
  )
  if (r) {
    notice.value = r.discovery.added
      ? `${r.discovery.added} new account(s) found.`
      : 'No new accounts.'
    emit('changed', r.connection)
  }
}

async function disconnect() {
  if (!confirmDisconnect.value) {
    confirmDisconnect.value = true
    return
  }
  const done = await run(() => api(`/api/connections/${props.connection.id}`, { method: 'DELETE' }))
  confirmDisconnect.value = false
  if (done) emit('removed')
}
</script>

<template>
  <v-card border flat class="mb-4">
    <v-card-title class="d-flex align-center flex-wrap ga-2">
      <span>{{ connection.label }}</span>
      <v-chip size="small" :color="status.color" :prepend-icon="status.icon">{{
        status.text
      }}</v-chip>
    </v-card-title>
    <v-card-subtitle>Last synced: {{ lastSynced }}</v-card-subtitle>

    <v-card-text>
      <v-alert
        v-if="connection.lastError"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-3"
      >
        {{ connection.lastError }}
      </v-alert>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
        error
      }}</v-alert>
      <v-alert
        v-if="notice"
        type="info"
        variant="tonal"
        density="compact"
        class="mb-3"
        role="status"
        >{{ notice }}</v-alert
      >
      <v-alert
        v-if="live && hasUnassigned"
        type="info"
        variant="outlined"
        density="compact"
        class="mb-3"
      >
        Choose a Space for each account you want Pond to track. Accounts left as "Not tracked" stay
        hidden.
      </v-alert>

      <v-table v-if="connection.accounts.length" density="comfortable">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Type</th>
            <th scope="col" style="min-width: 220px">Space</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in connection.accounts" :key="a.id">
            <td>
              {{ a.name }}
              <div v-if="a.institutionName" class="text-caption text-medium-emphasis">
                {{ a.institutionName }}
              </div>
            </td>
            <td>{{ typeLabel(a.type) }}</td>
            <td>
              <v-select
                :model-value="a.primarySpaceId"
                :items="itemsFor(a)"
                :aria-label="`Space for ${a.name}`"
                density="compact"
                hide-details
                :disabled="busy || !live"
                @update:model-value="(v: string | null) => assign(a, v)"
              />
            </td>
          </tr>
        </tbody>
      </v-table>
      <p v-else class="text-medium-emphasis">No accounts found yet.</p>
    </v-card-text>

    <v-card-actions v-if="live" class="px-4 pb-3">
      <v-btn color="primary" prepend-icon="mdi-sync" :loading="busy" @click="sync">Sync now</v-btn>
      <v-btn variant="text" :disabled="busy" @click="refreshAccounts">Find new accounts</v-btn>
      <v-spacer />
      <v-btn
        variant="text"
        :color="confirmDisconnect ? 'error' : undefined"
        :disabled="busy"
        @click="disconnect"
      >
        {{ confirmDisconnect ? 'Click again to disconnect' : 'Disconnect' }}
      </v-btn>
    </v-card-actions>
  </v-card>
</template>
