<script setup lang="ts">
import { usePadHost } from '@pond/sdk/client'
import { formatMoney } from '@pond/shared'
import { onMounted, ref } from 'vue'
import { taxYearOf, taxYearRange, today } from './logic'
import type { ProfitAndLoss } from './types'

const host = usePadHost()
const report = ref<ProfitAndLoss | null>(null)
const failed = ref(false)

onMounted(async () => {
  try {
    const { taxYearStartMonth } = await host.api.get<{ taxYearStartMonth: number }>(
      '/reports/context',
    )
    report.value = await host.api.get<ProfitAndLoss>(
      '/reports/profit-loss',
      taxYearRange(taxYearOf(today(), taxYearStartMonth), taxYearStartMonth),
    )
  } catch {
    failed.value = true
  }
})
</script>

<template>
  <p v-if="failed" class="text-medium-emphasis">Couldn't load the report.</p>
  <div v-else-if="report">
    <div class="text-h5">
      {{ report.totals.netCents < 0 ? 'Loss' : 'Profit' }}
      {{ formatMoney(Math.abs(report.totals.netCents)) }}
    </div>
    <div class="text-medium-emphasis">
      {{ formatMoney(report.totals.incomeCents) }} in,
      {{ formatMoney(report.totals.expenseCents) }} spent
    </div>
    <div v-if="report.uncategorized.count" class="text-caption">
      <v-icon icon="mdi-alert-outline" size="x-small" aria-hidden="true" />
      {{ report.uncategorized.count }} without a category, not counted
    </div>
    <router-link to="/p/business/reports" class="text-body-2">Business reports</router-link>
  </div>
</template>
