<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import PadSlot from '../components/pads/PadSlot.vue'
import { usePadsStore } from '../stores/pads'

const route = useRoute()
const pads = usePadsStore()
const padId = computed(() => String(route.params.padId))
const path = computed(() => {
  const p = route.params.pagePath
  return Array.isArray(p) ? p.join('/') : String(p ?? '')
})
const page = computed(() => pads.pageFor(padId.value, path.value))
</script>

<template>
  <PadSlot v-if="page" :key="`${padId}/${path}`" :pad-id="padId" :component="page.component" />
  <p v-else class="text-medium-emphasis">This page isn't available in this Space.</p>
</template>
