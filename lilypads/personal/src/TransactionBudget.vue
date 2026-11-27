<script setup lang="ts">
import { usePadHost } from '@pond/sdk/client'
import { formatMoney } from '@pond/shared'
import { onMounted, ref } from 'vue'

interface Line {
  categoryId: string
  name: string
  budgetedCents: number
  leftCents: number
}
const props = defineProps<{ transactionId: string }>()
const host = usePadHost()
const month = ref('')
const lines = ref<Line[]>([])

onMounted(async () => {
  try {
    const r = await host.api.get<{ month: string; lines: Line[] }>(
      `/transactions/${props.transactionId}`,
    )
    month.value = new Date(`${r.month}-01T12:00:00`).toLocaleDateString(undefined, {
      month: 'long',
    })
    lines.value = r.lines
  } catch {
    lines.value = []
  }
})
</script>

<template>
  <div v-if="lines.length" class="text-caption text-medium-emphasis">
    <div v-for="l in lines" :key="l.categoryId">
      <v-icon
        :icon="l.leftCents < 0 ? 'mdi-alert-circle-outline' : 'mdi-check-circle-outline'"
        size="x-small"
        aria-hidden="true"
      />
      {{ l.name }}: {{ formatMoney(Math.abs(l.leftCents)) }}
      {{ l.leftCents < 0 ? 'over' : 'left' }} of {{ formatMoney(l.budgetedCents) }} in {{ month }}
    </div>
  </div>
</template>
