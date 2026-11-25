<script setup lang="ts">
import { usePadHost } from '@pond/sdk'
import { ref, watch } from 'vue'
import { errorCode } from './ui'

/** A masked tax ID with a "Show" button. Pond asks for the password before sending the full one. */
const props = defineProps<{ masked: string; path: string }>()
const host = usePadHost()
const full = ref<string | null>(null)
const problem = ref('')
// Never keep one record's number on screen for another.
watch(
  () => [props.path, props.masked],
  () => {
    full.value = null
    problem.value = ''
  },
)

async function show() {
  problem.value = ''
  try {
    full.value = (await host.api.get<{ taxId: string }>(props.path)).taxId
  } catch (e) {
    // Closing the password box is not an error worth mentioning.
    if (errorCode(e) !== 'reauth_required') problem.value = "Couldn't show it."
  }
}
</script>

<template>
  <span class="d-inline-flex align-center ga-2">
    <span style="font-variant-numeric: tabular-nums">{{ full ?? masked }}</span>
    <v-btn
      size="x-small"
      variant="tonal"
      :prepend-icon="full ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
      @click="full ? (full = null) : show()"
      >{{ full ? 'Hide' : 'Show' }}</v-btn
    >
    <span v-if="problem" class="text-caption text-error">{{ problem }}</span>
  </span>
</template>
