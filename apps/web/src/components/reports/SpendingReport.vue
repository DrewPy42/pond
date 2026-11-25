<script setup lang="ts">
import { formatMoney, type SpendingReport } from '@pond/shared'
import { computed, onMounted, ref, watch } from 'vue'
import { sharePercent } from '../../composables/charts'
import { spendingPeriods } from '../../composables/reportPeriods'
import { useAction } from '../../composables/useAction'
import { useSpaceApi } from '../../composables/useSpaceApi'
import ReportNotes from './ReportNotes.vue'

/** Spending ranked by category. The list is the chart and its own table. */
const space = useSpaceApi()
const { busy, error, run } = useAction()
const periods = spendingPeriods()
const picked = ref('month')
const report = ref<SpendingReport | null>(null)
const money = (cents: number) => formatMoney(cents, space.currency.value)
const positive = computed(
  () => report.value?.lines.reduce((n, l) => n + Math.max(l.cents, 0), 0) ?? 0,
)
const largest = computed(() => Math.max(0, ...(report.value?.lines.map((l) => l.cents) ?? [])))
const width = (cents: number) =>
  largest.value > 0 && cents > 0 ? (cents / largest.value) * 100 : 0

async function load() {
  const p = periods.find((x) => x.key === picked.value)!
  const r = await run(() =>
    space.get<SpendingReport>(`/reports/spending?from=${p.from}&to=${p.to}`),
  )
  report.value = r ?? null
}
onMounted(load)
watch([picked, space.spaceId], load)
</script>

<template>
  <v-select
    v-model="picked"
    :items="periods"
    item-title="title"
    item-value="key"
    label="Period"
    style="max-width: 240px"
  />
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>
  <v-progress-linear v-if="busy" indeterminate class="mb-2" />
  <template v-if="report">
    <ReportNotes :other-currency-accounts="report.otherCurrencyAccounts" />
    <p v-if="report.lines.length === 0" class="text-medium-emphasis">No spending in this period.</p>
    <template v-else>
      <div class="text-medium-emphasis text-body-2">Total spending</div>
      <div class="text-h6 mb-3">{{ money(report.totalCents) }}</div>
      <table class="spending">
        <caption class="d-sr-only">
          Spending by category
        </caption>
        <thead class="d-sr-only">
          <tr>
            <th>Category</th>
            <th>Share</th>
            <th>Amount</th>
            <th>Percent</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in report.lines" :key="l.categoryId ?? 'none'">
            <th scope="row">{{ l.name }}</th>
            <td class="track" aria-hidden="true">
              <span :style="{ width: `${width(l.cents)}%` }" />
            </td>
            <td class="amount">{{ money(l.cents) }}</td>
            <td class="percent">
              {{ l.cents < 0 ? 'refunds' : `${sharePercent(l.cents, positive)}%` }}
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </template>
</template>

<style scoped>
.spending {
  width: 100%;
  border-collapse: collapse;
}
.spending th {
  text-align: left;
  font-weight: 400;
  padding: 6px 12px 6px 0;
  width: 1%;
  min-width: 130px;
  white-space: nowrap;
}
.track {
  width: 99%;
}
.track span {
  display: block;
  height: 14px;
  min-width: 0;
  border-radius: 0 4px 4px 0;
  background: rgb(var(--v-theme-chart-1));
}
.amount,
.percent {
  text-align: right;
  white-space: nowrap;
  padding-left: 12px;
  font-variant-numeric: tabular-nums;
}
.percent {
  opacity: 0.7;
  min-width: 56px;
}
</style>
