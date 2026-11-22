<script setup lang="ts">
import type { ConnectionView } from '@pond/shared'
import { onMounted, ref } from 'vue'
import { api } from '../api'
import ConnectBankDialog from '../components/connections/ConnectBankDialog.vue'
import ConnectionCard from '../components/connections/ConnectionCard.vue'
import { useAction } from '../composables/useAction'
import { useAuthStore } from '../stores/auth'
import { useSpacesStore } from '../stores/spaces'

const auth = useAuthStore()
const spaces = useSpacesStore()
const { busy, error, run } = useAction()
const connections = ref<ConnectionView[]>([])
const connectOpen = ref(false)

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

  <template v-if="auth.user?.isAdmin">
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
  </template>
  <p v-else class="text-medium-emphasis">There is nothing to configure yet.</p>
</template>
