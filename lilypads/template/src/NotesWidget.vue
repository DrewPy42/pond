<script setup lang="ts">
import { usePadHost } from '@pond/sdk/client'
import { onMounted, ref } from 'vue'

const host = usePadHost()
const open = ref<number | null>(null)

onMounted(async () => {
  try {
    open.value = (await host.api.get<{ open: number }>('/summary')).open
  } catch {
    open.value = null
  }
})
</script>

<template>
  <div>
    <div class="text-h4">{{ open ?? '-' }}</div>
    <div class="text-medium-emphasis">open notes</div>
  </div>
</template>
