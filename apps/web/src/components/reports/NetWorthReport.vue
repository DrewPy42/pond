<script setup lang="ts">
import { formatMoney, type NetWorthReport } from '@pond/shared'
import { computed, onMounted, ref, watch } from 'vue'
import { monthLabel } from '../../composables/charts'
import { isoDay } from '../../composables/reportPeriods'
import { useAction } from '../../composables/useAction'
import { useSpaceApi } from '../../composables/useSpaceApi'
import { MoneyAmount } from '../common'
import NetWorthChart from './NetWorthChart.vue'
import ReportNotes from './ReportNotes.vue'

const space = useSpaceApi()
const { busy, error, run } = useAction()
const span = ref(12)
const report = ref<NetWorthReport | null>(null)
const spans = [
  { title: 'Last 12 months', value: 12 },
  { title: 'Last 3 years', value: 36 },
  { title: 'Last 10 years', value: 120 },
]
const now = computed(() => report.value?.points.at(-1) ?? null)
const money = (cents: number) => formatMoney(cents, space.currency.value)

async function load() {
  const r = await run(() =>
    space.get<NetWorthReport>(
      `/reports/net-worth?today=${isoDay(new Date())}&months=${span.value}`,
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
    <ReportNotes :other-currency-accounts="report.otherCurrencyAccounts" />
    <p v-if="!now" class="text-medium-emphasis">
      No balances yet. Give an account a balance on the
      <router-link to="/accounts">Accounts</router-link> page, or connect a bank.
    </p>
    <template v-else>
      <div class="d-flex flex-wrap ga-6 mb-4">
        <div>
          <div class="text-medium-emphasis text-body-2">Net worth today</div>
          <div class="text-h5">{{ money(now.netCents) }}</div>
        </div>
        <div>
          <div class="text-medium-emphasis text-body-2">You have</div>
          <div class="text-h6">{{ money(now.assetsCents) }}</div>
        </div>
        <div>
          <div class="text-medium-emphasis text-body-2">You owe</div>
          <div class="text-h6">{{ money(now.debtsCents) }}</div>
        </div>
      </div>
      <NetWorthChart :points="report.points" :currency="space.currency.value" />
      <p v-if="report.points.length === 1" class="text-caption text-medium-emphasis">
        History builds up from the first balance Pond knows about.
      </p>
      <v-expansion-panels class="mt-3" variant="accordion">
        <v-expansion-panel title="Month by month">
          <v-expansion-panel-text>
            <v-table density="compact" class="money-table">
              <thead>
                <tr>
                  <th class="text-left">Month</th>
                  <th class="text-right">You have</th>
                  <th class="text-right">You owe</th>
                  <th class="text-right">Net worth</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in [...report.points].reverse()" :key="p.date">
                  <td>{{ monthLabel(p.date, true) }}{{ p.missing ? ' *' : '' }}</td>
                  <td class="text-right">{{ money(p.assetsCents) }}</td>
                  <td class="text-right">{{ money(p.debtsCents) }}</td>
                  <td class="text-right">{{ money(p.netCents) }}</td>
                </tr>
              </tbody>
            </v-table>
            <p v-if="report.points.some((p) => p.missing)" class="text-caption mt-2">
              * Some accounts had no balance recorded yet, so they aren't counted that month.
            </p>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </template>

    <template v-if="report.accounts.length">
      <h3 class="text-subtitle-1 mt-5 mb-1">Accounts counted</h3>
      <v-table density="compact">
        <tbody>
          <tr v-for="a in report.accounts" :key="a.accountId">
            <td>{{ a.name }}</td>
            <td class="text-medium-emphasis">
              {{ a.balanceDate ? `as of ${a.balanceDate}` : '' }}
            </td>
            <td class="text-right">
              <MoneyAmount
                v-if="a.balanceCents !== null"
                :cents="a.balanceCents"
                :currency="space.currency.value"
                plain
              />
              <span v-else class="text-medium-emphasis">No balance yet</span>
            </td>
          </tr>
        </tbody>
      </v-table>
      <p class="text-caption text-medium-emphasis mt-1">
        Money you owe is a negative balance. Choose which accounts count on the Accounts page.
      </p>
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
