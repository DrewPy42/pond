<script setup lang="ts">
import type { AvailableSpacePad } from '@pond/shared'
import { onMounted, ref, watch } from 'vue'
import { api } from '../../api'
import { useAction } from '../../composables/useAction'
import { usePadsStore } from '../../stores/pads'
import { useSpacesStore } from '../../stores/spaces'
import PadSettingsDialog from './PadSettingsDialog.vue'

/** For Space owners: switch installed apps on or off for this Space, and change their settings. */
const spaces = useSpacesStore()
const pads = usePadsStore()
const { busy, error, run } = useAction()
const available = ref<AvailableSpacePad[]>([])
const settingsFor = ref<string | null>(null)
const settingsOpen = ref(false)

async function load() {
  const id = spaces.active?.id
  if (!id) return
  const r = await run(() => api<{ pads: AvailableSpacePad[] }>(`/api/spaces/${id}/pads/available`))
  if (r) available.value = r.pads
}
onMounted(load)
watch(() => spaces.active?.id, load)

async function toggle(p: AvailableSpacePad, on: boolean | null) {
  const id = spaces.active?.id
  if (!id) return
  await run(() =>
    api(`/api/spaces/${id}/pads/${p.id}/enabled`, { method: 'PUT', body: { enabled: !!on } }),
  )
  await load()
  await pads.load(id) // the sidebar and dashboard follow immediately
}
const openSettings = (p: AvailableSpacePad) => {
  settingsFor.value = p.id
  settingsOpen.value = true
}
</script>

<template>
  <h2 class="text-h6 mb-1">Apps in {{ spaces.active?.name }}</h2>
  <p class="text-body-2 text-medium-emphasis mb-3">
    Apps your administrator has installed. Turn on the ones you want in this Space.
  </p>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>
  <p v-if="!busy && available.length === 0" class="text-medium-emphasis">
    There are no apps available for this kind of Space yet.
  </p>
  <v-card v-for="p in available" :key="p.id" border flat class="mb-3">
    <v-card-text class="d-flex align-center ga-4 flex-wrap">
      <div style="flex: 1; min-width: 220px">
        <div class="text-subtitle-1">{{ p.name }}</div>
        <div v-if="p.description" class="text-body-2 text-medium-emphasis">{{ p.description }}</div>
        <div v-if="!p.touchesFinances" class="text-caption text-medium-emphasis mt-1">
          Can't see your accounts or transactions.
        </div>
      </div>
      <v-btn v-if="p.enabled && p.hasSettings" variant="text" size="small" @click="openSettings(p)"
        >Settings</v-btn
      >
      <v-switch
        :model-value="p.enabled"
        :label="p.enabled ? 'On' : 'Off'"
        :aria-label="`Use ${p.name} in this Space`"
        color="secondary"
        hide-details
        density="compact"
        :disabled="busy"
        @update:model-value="(v: boolean | null) => toggle(p, v)"
      />
    </v-card-text>
  </v-card>
  <PadSettingsDialog
    v-model="settingsOpen"
    :space-id="spaces.active?.id ?? ''"
    :pad-id="settingsFor"
  />
</template>
