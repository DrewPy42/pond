<script setup lang="ts">
import { usePadHost } from '@pond/sdk/client'
import { formatMoney } from '@pond/shared'
import { onMounted, ref } from 'vue'
import { currentMonth } from './logic'

interface Totals {
  budgetedCents: number
  spentCents: number
  leftCents: number
}
const host = usePadHost()
const totals = ref<Totals | null>(null)
const failed = ref(false)

onMounted(async () => {
  try {
    const r = await host.api.get<{ totals: Totals; lines: unknown[] }>('/budget', {
      month: currentMonth(),
    })
    totals.value = r.lines.length ? r.totals : null
  } catch {
    failed.value = true
  }
})
</script>

<template>
  <p v-if="failed" class="text-medium-emphasis">Couldn't load your budget.</p>
  <div v-else-if="totals">
    <div class="text-h5">
      <v-icon
        :icon="totals.leftCents < 0 ? 'mdi-alert-circle-outline' : 'mdi-check-circle-outline'"
        size="small"
        aria-hidden="true"
      />
      {{ formatMoney(Math.abs(totals.leftCents)) }}
      {{ totals.leftCents < 0 ? 'over' : 'left' }}
    </div>
    <div class="text-medium-emphasis">
      {{ formatMoney(totals.spentCents) }} spent of {{ formatMoney(totals.budgetedCents) }} this
      month
    </div>
    <router-link to="/p/personal/budget" class="text-body-2">Open budget</router-link>
  </div>
  <p v-else class="text-medium-emphasis">
    No budget yet. <router-link to="/p/personal/budget">Set one up</router-link>
  </p>
</template>
