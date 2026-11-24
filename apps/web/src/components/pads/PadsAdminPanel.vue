<script setup lang="ts">
import type { PadListing } from '@pond/shared'
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api'
import { FormDialog } from '../common'
import { useAction } from '../../composables/useAction'

/** For the administrator: see the apps shipped with Pond, install them (approving what they can access) and remove them. */
const { busy, error, run } = useAction()
const pads = ref<PadListing[]>([])
const installing = ref<PadListing | null>(null)
const installOpen = ref(false)
const removing = ref<PadListing | null>(null)
const removeOpen = ref(false)
const deleteData = ref(false)

async function load() {
  const r = await run(() => api<{ pads: PadListing[] }>('/api/lilypads'))
  if (r) pads.value = r.pads
}
onMounted(load)

const label = (p: PadListing) =>
  ({
    available: 'Not installed',
    running: 'Installed',
    needs_approval: 'Needs approval',
    incompatible: 'Incompatible',
    error: 'Problem',
  })[p.state]
const color = (p: PadListing) =>
  p.state === 'running' ? 'secondary' : p.state === 'available' ? undefined : 'warning'

const ask = (p: PadListing) => {
  installing.value = p
  installOpen.value = true
}
async function doInstall() {
  const p = installing.value
  if (!p) return
  const done = await run(() =>
    api(`/api/lilypads/${p.id}/install`, {
      method: 'POST',
      body: { permissions: p.permissions.map((x) => x.permission) },
    }),
  )
  if (done) {
    installOpen.value = false
    await load()
  }
}
const askRemove = (p: PadListing) => {
  removing.value = p
  deleteData.value = false
  removeOpen.value = true
}
async function doRemove() {
  const p = removing.value
  if (!p) return
  const done = await run(() =>
    api(`/api/lilypads/${p.id}/uninstall`, {
      method: 'POST',
      body: { deleteData: deleteData.value },
    }),
  )
  if (done) {
    removeOpen.value = false
    await load()
  }
}
const installTitle = computed(() =>
  installing.value?.state === 'needs_approval' ? 'Approve the update' : 'Install this app',
)
</script>

<template>
  <h2 class="text-h6 mb-1">Apps</h2>
  <p class="text-body-2 text-medium-emphasis mb-3">
    Optional add-ons that ship with Pond. Install the ones you want, then Space owners choose where
    to use them.
  </p>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>
  <p v-if="!busy && pads.length === 0" class="text-medium-emphasis">
    There are no apps in this version of Pond yet.
  </p>
  <v-card v-for="p in pads" :key="p.id" border flat class="mb-3">
    <v-card-title class="d-flex align-center ga-2 flex-wrap">
      <span>{{ p.name }}</span>
      <v-chip size="x-small" :color="color(p)">{{ label(p) }}</v-chip>
      <v-chip size="x-small">v{{ p.version }}</v-chip>
    </v-card-title>
    <v-card-text>
      <p v-if="p.description" class="mb-2">{{ p.description }}</p>
      <v-alert
        v-if="p.problem && p.installed"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-2"
        >{{ p.problem }}</v-alert
      >
      <div class="text-caption text-medium-emphasis">
        Works in {{ p.spaceTypes.join(' and ') }} Spaces ·
        <template v-if="p.installed"
          >On in {{ p.enabledSpaceIds.length }}
          {{ p.enabledSpaceIds.length === 1 ? 'Space' : 'Spaces' }}</template
        >
      </div>
    </v-card-text>
    <v-card-actions>
      <v-btn v-if="!p.installed || p.state === 'needs_approval'" color="primary" @click="ask(p)">
        {{ p.state === 'needs_approval' ? 'Review and approve' : 'Install' }}
      </v-btn>
      <v-spacer />
      <v-btn v-if="p.installed" variant="text" @click="askRemove(p)">Remove</v-btn>
    </v-card-actions>
  </v-card>

  <FormDialog
    v-model="installOpen"
    :title="installTitle"
    submit-label="Approve and install"
    :busy="busy"
    :error="error"
    :max-width="520"
    @submit="doInstall"
  >
    <p class="mb-2">
      <strong>{{ installing?.name }}</strong> will be able to:
    </p>
    <ul v-if="installing?.permissions.length" class="pl-5 mb-3">
      <li v-for="x in installing.permissions" :key="x.permission">{{ x.description }}</li>
    </ul>
    <p v-else class="mb-3">
      Only use its own information. It can't see your accounts or transactions.
    </p>
    <p class="text-caption text-medium-emphasis">
      It only works in Spaces where an owner turns it on.
    </p>
  </FormDialog>

  <FormDialog
    v-model="removeOpen"
    :title="`Remove ${removing?.name ?? 'app'}`"
    submit-label="Remove"
    :busy="busy"
    :error="error"
    :max-width="480"
    @submit="doRemove"
  >
    <p class="mb-3">The app will stop working in every Space.</p>
    <v-checkbox
      v-model="deleteData"
      label="Also delete everything this app stored"
      hide-details
      density="compact"
    />
    <p class="text-caption text-medium-emphasis mt-2">
      {{
        deleteData
          ? "This can't be undone."
          : 'Its information is kept, so installing it again brings it back.'
      }}
    </p>
  </FormDialog>
</template>
