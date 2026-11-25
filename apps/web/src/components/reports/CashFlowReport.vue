<script setup lang="ts">
import { formatMoney, type CashFlowReport } from '@pond/shared'
import { computed, onMounted, ref, watch } from 'vue'
import { monthLabel } from '../../composables/charts'
import { isoMonth, monthsAgo } from '../../composables/reportPeriods'
import { useAction } from '../../composables/useAction'
import { useSpaceApi } from '../../composables/useSpaceApi'
import { MoneyAmount } from '../common'
import CashFlowChart from './CashFlowChart.vue'
import ReportNotes from './ReportNotes.vue'

const space = useSpaceApi()
const { busy, error, run } = useAction()
const span = ref(12)
const report = ref<CashFlowReport | null>(null)
const spans = [
  { title: 'Last 6 months', value: 6 },
  { title: 'Last 12 months', value: 12 },
  { title: 'Last 24 months', value: 24 },
]
const empty = computed(() => report.value?.months.every((m) => m.inCents === 0 && m.outCents === 0))
const money = (cents: number) => formatMoney(cents, space.currency.value)

async function load() {
  const r = await run(() =>
    space.get<CashFlowReport>(
      `/reports/cash-flow?from=${monthsAgo(span.value - 1)}&to=${isoMonth(new Date())}`,
    ),
  )
  report.value = r ?? null
}
onMounted(load)
watch([span, space.spaceId], load)
</script>

<template>
  <v-select v-model="span" :items="spans" label="Period" style="max-width: 240px" />
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>
  <v-progress-linear v-if="busy" indeterminate class="mb-2" />
  <template v-if="report">
    <ReportNotes :other-currency-accounts="report.otherCurrencyAccounts">
      <template v-if="report.uncategorizedCount"
        >{{ report.uncategorizedCount }} amount(s) have no category yet. They are counted as money
        in or out by their direction, so moving money between your own accounts may show up until it
        is linked as a transfer.
        <router-link to="/transactions">Review transactions</router-link></template
      >
    </ReportNotes>
    <p v-if="empty" class="text-medium-emphasis">No money moved in this period.</p>
    <template v-else>
      <div class="d-flex flex-wrap ga-6 mb-4">
        <div>
          <div class="text-medium-emphasis text-body-2">Money in</div>
          <div class="text-h6">{{ money(report.totals.inCents) }}</div>
        </div>
        <div>
          <div class="text-medium-emphasis text-body-2">Money out</div>
          <div class="text-h6">{{ money(report.totals.outCents) }}</div>
        </div>
        <div>
          <div class="text-medium-emphasis text-body-2">Difference</div>
          <div class="text-h6">
            <MoneyAmount :cents="report.totals.netCents" :currency="space.currency.value" />
          </div>
        </div>
      </div>
      <CashFlowChart :months="report.months" :currency="space.currency.value" />
      <v-table density="compact" class="mt-4 money-table">
        <thead>
          <tr>
            <th class="text-left">Month</th>
            <th class="text-right">Money in</th>
            <th class="text-right">Money out</th>
            <th class="text-right">Difference</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in [...report.months].reverse()" :key="m.month">
            <td>{{ monthLabel(m.month, true) }}</td>
            <td class="text-right">{{ money(m.inCents) }}</td>
            <td class="text-right">{{ money(m.outCents) }}</td>
            <td class="text-right">
              <MoneyAmount :cents="m.netCents" :currency="space.currency.value" />
            </td>
          </tr>
        </tbody>
      </v-table>
    </template>
  </template>
</template>

<style scoped>
/* Four money columns have to fit a phone without sideways scrolling. */
@media (max-width: 600px) {
  .money-table :deep(th),
  .money-table :deep(td) {
    padding: 0 4px !important;
    font-size: 0.75rem !important;
  }
}
</style>
