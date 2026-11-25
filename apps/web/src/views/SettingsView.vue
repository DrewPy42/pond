<script setup lang="ts">
import type { ConnectionView } from '@pond/shared'
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'
import ConnectBankDialog from '../components/connections/ConnectBankDialog.vue'
import ConnectionCard from '../components/connections/ConnectionCard.vue'
import PadsAdminPanel from '../components/pads/PadsAdminPanel.vue'
import PadsSpacePanel from '../components/pads/PadsSpacePanel.vue'
import PasswordPanel from '../components/spaces/PasswordPanel.vue'
import SpacesPanel from '../components/spaces/SpacesPanel.vue'
import UsersPanel from '../components/spaces/UsersPanel.vue'
import { useAction } from '../composables/useAction'
import { useAuthStore } from '../stores/auth'
import { useSpacesStore } from '../stores/spaces'

const auth = useAuthStore()
const spaces = useSpacesStore()
const { busy, error, run } = useAction()
const connections = ref<ConnectionView[]>([])
const connectOpen = ref(false)
const canManageSpace = computed(() => spaces.active?.role === 'owner')

async function load() {
  if (!auth.user?.isAdmin) return
  const r = await run(() => api<{ connections: ConnectionView[] }>('/api/connections'))
  if (r) connections.value = r.connections
}
onMounted(async () => {
  if (!spaces.spaces.length) await spaces.load()
  await load()
})

/** Replace one connection in place when the server returned a fresh copy; otherwise reload. */
function changed(updated?: ConnectionView) {
  if (!updated) return load()
  connections.value = connections.value.map((c) => (c.id === updated.id ? updated : c))
}
async function connected(c: ConnectionView) {
  connections.value = [...connections.value, c]
  await load()
}
</script>

<template>
  <h1 class="text-h5 mb-4">Settings</h1>

  <SpacesPanel />

  <template v-if="auth.user?.isAdmin">
    <v-divider class="my-6" />
    <UsersPanel />

    <v-divider class="my-6" />
    <div class="d-flex align-center mb-3 ga-3 flex-wrap">
      <h2 class="text-h6">Bank connections</h2>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="connectOpen = true"
        >Connect a bank</v-btn
      >
    </div>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{
      error
    }}</v-alert>
    <p v-if="!busy && connections.length === 0" class="text-medium-emphasis">
      No banks connected yet. Connect one to pull in your accounts and transactions automatically.
    </p>
    <ConnectionCard
      v-for="c in connections"
      :key="c.id"
      :connection="c"
      @changed="changed"
      @removed="load"
    />
    <ConnectBankDialog v-model="connectOpen" @connected="connected" />

    <v-divider class="my-6" />
    <PadsAdminPanel />
  </template>

  <template v-if="canManageSpace && spaces.active">
    <v-divider class="my-6" />
    <PadsSpacePanel :key="spaces.active.id" />
  </template>

  <v-divider class="my-6" />
  <PasswordPanel />
</template>
