<script setup lang="ts">
import { usePadHost } from '@pond/sdk'
import { onMounted, ref } from 'vue'

defineProps<{ transactionId: string }>()
const host = usePadHost()
const seen = ref<number | null>(null)

onMounted(async () => {
  try {
    seen.value = (await host.api.get<{ transactionsSeen: number }>('/summary')).transactionsSeen
  } catch {
    seen.value = null
  }
})
</script>

<template>
  <div class="text-caption text-medium-emphasis">
    Notes pad: has seen {{ seen ?? '-' }} new transactions in this Space.
  </div>
</template>
