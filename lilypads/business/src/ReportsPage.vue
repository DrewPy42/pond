<script setup lang="ts">
import { usePadHost } from '@pond/sdk'
import { formatMoney } from '@pond/shared'
import { computed, onMounted, ref } from 'vue'
import { periodsFor, taxYearOf, taxYearRange, today, type Period } from './logic'
import ReportSection from './ReportSection.vue'
import type { ProfitAndLoss, TaxSummary, TaxSummaryCategory } from './types'
import { errorCode, saveCsv } from './ui'

const host = usePadHost()
const tab = ref<'pl' | 'tax'>('pl')
const error = ref('')
const startMonth = ref(1)
const periods = ref<Period[]>([])
const picked = ref<Period['key'] | null>('year')
const from = ref('')
const to = ref('')
const pl = ref<ProfitAndLoss | null>(null)
const year = ref(new Date().getFullYear())
const summary = ref<TaxSummary | null>(null)

const longDate = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' })
const yearOptions = computed(() => {
  const current = taxYearOf(today(), startMonth.value)
  return Array.from({ length: 8 }, (_, i) => {
    const y = current - i
    const r = taxYearRange(y, startMonth.value)
    return { value: y, title: `${longDate(r.from)} to ${longDate(r.to)}` }
  })
})
const uncategorized = computed(() => (tab.value === 'pl' ? pl.value : summary.value)?.uncategorized)

async function loadProfitAndLoss() {
  if (!from.value || !to.value || from.value > to.value) {
    pl.value = null
    return
  }
  try {
    pl.value = await host.api.get<ProfitAndLoss>('/reports/profit-loss', {
      from: from.value,
      to: to.value,
    })
    error.value = ''
  } catch {
    error.value = "Couldn't load the report."
  }
}
async function loadSummary() {
  try {
    summary.value = await host.api.get<TaxSummary>('/reports/tax-summary', { year: year.value })
    error.value = ''
  } catch {
    error.value = "Couldn't load the tax summary."
  }
}
function pick(p: Period) {
  picked.value = p.key
  from.value = p.from
  to.value = p.to
  loadProfitAndLoss()
}
function typedDate() {
  picked.value = null
  loadProfitAndLoss()
}

async function exportCsv() {
  const range =
    tab.value === 'pl'
      ? { from: from.value, to: to.value }
      : taxYearRange(year.value, startMonth.value)
  try {
    const r = await host.api.get<{ filename: string; csv: string }>('/reports/export', range)
    saveCsv(r.filename, r.csv)
    error.value = ''
  } catch (e) {
    error.value =
      errorCode(e) === 'too_many_to_export'
        ? 'That range has too many transactions to export at once. Choose a shorter one.'
        : "Couldn't export."
  }
}

// ----- partly deductible categories (owners) -----
const marking = ref<TaxSummaryCategory | null>(null)
const percent = ref(50)
function openMark(c: TaxSummaryCategory) {
  marking.value = c
  percent.value = c.percent ?? 50
}
async function saveMark(value: number | null) {
  const c = marking.value
  if (!c) return
  try {
    await host.api.put(`/reports/deductions/${c.categoryId}`, { percent: value })
    marking.value = null
    await loadSummary()
  } catch {
    error.value = "Couldn't save that."
  }
}

onMounted(async () => {
  try {
    startMonth.value = (
      await host.api.get<{ taxYearStartMonth: number }>('/reports/context')
    ).taxYearStartMonth
  } catch {
    error.value = "Couldn't load the report settings."
  }
  periods.value = periodsFor(today(), startMonth.value)
  year.value = taxYearOf(today(), startMonth.value)
  pick(periods.value.find((p) => p.key === 'year')!)
  loadSummary()
})
</script>

<template>
  <div class="d-flex align-center mb-3 flex-wrap ga-2">
    <h1 class="text-h5 mr-auto">Business reports</h1>
    <v-btn color="primary" prepend-icon="mdi-download" @click="exportCsv"
      >Export for your accountant</v-btn
    >
  </div>
  <v-tabs v-model="tab" class="mb-4">
    <v-tab value="pl">Profit and loss</v-tab>
    <v-tab value="tax">Tax summary</v-tab>
  </v-tabs>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>

  <template v-if="tab === 'pl'">
    <div class="d-flex ga-2 flex-wrap mb-3">
      <v-btn
        v-for="p in periods"
        :key="p.key"
        size="small"
        :variant="picked === p.key ? 'flat' : 'outlined'"
        :color="picked === p.key ? 'primary' : undefined"
        :aria-pressed="picked === p.key"
        @click="pick(p)"
        >{{ p.label }}</v-btn
      >
    </div>
    <div class="d-flex ga-3 flex-wrap" style="max-width: 460px">
      <v-text-field v-model="from" label="From" type="date" @change="typedDate" />
      <v-text-field v-model="to" label="To" type="date" @change="typedDate" />
    </div>
  </template>
  <v-select
    v-else
    v-model="year"
    :items="yearOptions"
    label="Tax year"
    style="max-width: 460px"
    @update:model-value="loadSummary"
  />

  <v-alert
    v-if="uncategorized && uncategorized.count > 0"
    type="warning"
    variant="tonal"
    density="compact"
    class="mb-4"
    >{{ uncategorized.count }} amount(s) have no category (net
    {{ formatMoney(uncategorized.netCents) }}) and are <strong>not</strong> in these totals.
    <router-link to="/transactions">Give them a category</router-link></v-alert
  >

  <template v-if="tab === 'pl' && pl">
    <ReportSection
      title="Income"
      :lines="pl.income"
      :total-cents="pl.totals.incomeCents"
      empty="No income in these dates."
    />
    <ReportSection
      title="Expenses"
      :lines="pl.expenses"
      :total-cents="pl.totals.expenseCents"
      empty="No spending in these dates."
    />
    <div class="text-h6" data-testid="net">
      {{ pl.totals.netCents < 0 ? 'Loss' : 'Profit' }}:
      {{ formatMoney(Math.abs(pl.totals.netCents)) }}
    </div>
  </template>

  <template v-if="tab === 'tax' && summary">
    <template
      v-for="section in [
        { title: 'Income', groups: summary.income, spending: false },
        { title: 'Expenses', groups: summary.expenses, spending: true },
      ]"
      :key="section.title"
    >
      <h2 class="text-h6 mb-1">{{ section.title }}</h2>
      <p v-if="section.groups.length === 0" class="text-medium-emphasis mb-4">
        Nothing in this tax year.
      </p>
      <v-table v-else density="compact" class="mb-4">
        <thead>
          <tr>
            <th class="text-left">Category</th>
            <th class="text-right">{{ section.spending ? 'Spent' : 'Received' }}</th>
            <th v-if="section.spending" class="text-right">Counted</th>
            <th v-if="section.spending && host.isOwner" />
          </tr>
        </thead>
        <tbody v-for="g in section.groups" :key="g.taxLine ?? ''">
          <tr class="font-weight-bold">
            <td>{{ g.taxLine ?? 'No tax line' }}</td>
            <td class="text-right">{{ formatMoney(g.totalCents) }}</td>
            <td v-if="section.spending" class="text-right">{{ formatMoney(g.countedCents) }}</td>
            <td v-if="section.spending && host.isOwner" />
          </tr>
          <tr v-for="c in g.categories" :key="c.categoryId">
            <td class="pl-8">
              {{ c.name }}
              <span v-if="c.percent !== null" class="text-medium-emphasis"
                >({{ c.percent }}% counted)</span
              >
            </td>
            <td class="text-right">{{ formatMoney(c.cents) }}</td>
            <td v-if="section.spending" class="text-right">{{ formatMoney(c.countedCents) }}</td>
            <td v-if="section.spending && host.isOwner" class="text-right">
              <v-btn
                icon="mdi-percent-outline"
                size="x-small"
                variant="text"
                :aria-label="`Choose how much of ${c.name} counts`"
                @click="openMark(c)"
              />
            </td>
          </tr>
        </tbody>
      </v-table>
    </template>
    <v-card variant="outlined" class="pa-4 mb-3">
      <div>Income: {{ formatMoney(summary.totals.incomeCents) }}</div>
      <div>
        Spent: {{ formatMoney(summary.totals.expenseCents) }} (counted:
        {{ formatMoney(summary.totals.countedExpenseCents) }})
      </div>
      <div class="font-weight-bold">
        {{ summary.totals.netCents < 0 ? 'Loss' : 'Profit' }} before any adjustments:
        {{ formatMoney(Math.abs(summary.totals.netCents)) }}
      </div>
    </v-card>
    <p class="text-caption text-medium-emphasis">
      This is a summary of your records to share with your accountant, not tax advice. Tax lines are
      the ones typed on the Categories page.
    </p>
  </template>

  <v-dialog :model-value="!!marking" max-width="420" @update:model-value="marking = null">
    <v-card :title="`How much of ${marking?.name ?? ''} counts?`">
      <v-card-text>
        <p class="text-medium-emphasis mb-3">
          Some kinds of spending only partly count. Ask your accountant if you're not sure.
        </p>
        <v-text-field
          v-model.number="percent"
          label="Percent counted"
          type="number"
          min="0"
          max="100"
          suffix="%"
        />
      </v-card-text>
      <v-card-actions>
        <v-btn variant="text" @click="saveMark(null)">Count all of it</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="marking = null">Cancel</v-btn>
        <v-btn
          color="primary"
          :disabled="!Number.isInteger(percent) || percent < 0 || percent > 100"
          @click="saveMark(percent)"
          >Save</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
