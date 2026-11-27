<script setup lang="ts">
import { usePadHost } from '@pond/sdk/client'
import { formatMoney } from '@pond/shared'
import { computed, onMounted, ref } from 'vue'
import { addMonths, currentMonth } from './logic'
import MoneyField from './MoneyField.vue'

interface Line {
  categoryId: string
  name: string
  budgetedCents: number
  spentCents: number
  leftCents: number
}
interface Budget {
  month: string
  lines: Line[]
  available: { id: string; name: string }[]
  totals: { budgetedCents: number; spentCents: number; leftCents: number }
}
interface Suggestion {
  categoryId: string
  name: string
  amountCents: number
}

const host = usePadHost()
const month = ref(currentMonth())
const budget = ref<Budget | null>(null)
const error = ref('')
const loading = ref(true)

const title = computed(() =>
  new Date(`${month.value}-01T12:00:00`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  }),
)
const money = (cents: number) => formatMoney(cents)
const percent = (l: { budgetedCents: number; spentCents: number }) =>
  Math.max(0, Math.min(100, Math.floor((l.spentCents * 100) / l.budgetedCents)))

async function load() {
  loading.value = true
  try {
    budget.value = await host.api.get<Budget>('/budget', { month: month.value })
    error.value = ''
  } catch {
    error.value = "Couldn't load your budget."
  } finally {
    loading.value = false
  }
}
function go(n: number) {
  month.value = addMonths(month.value, n)
  load()
}

// ----- change one amount (or add a category) -----
const editing = ref(false)
const editCategory = ref<string | null>(null)
const editName = ref('')
const editAmount = ref<number | null>(null)
const isNew = ref(false)

function openEdit(line: Line) {
  isNew.value = false
  editCategory.value = line.categoryId
  editName.value = line.name
  editAmount.value = line.budgetedCents
  editing.value = true
}
function openAdd() {
  isNew.value = true
  editCategory.value = null
  editName.value = ''
  editAmount.value = null
  editing.value = true
}
async function save(amount: number | null) {
  if (!editCategory.value || amount === null) return
  try {
    await host.api.put('/budget', {
      month: month.value,
      items: [{ categoryId: editCategory.value, amountCents: amount }],
    })
    editing.value = false
    await load()
  } catch {
    error.value = "Couldn't save that. Please try again."
  }
}

// ----- suggest a starting budget -----
const suggesting = ref(false)
const suggestions = ref<Suggestion[]>([])
const suggestionAmounts = ref<Record<string, number | null>>({})
const noHistory = ref(false)

async function openSuggest() {
  try {
    const r = await host.api.get<{ suggestions: Suggestion[] }>('/budget/suggest', {
      month: month.value,
    })
    suggestions.value = r.suggestions
    suggestionAmounts.value = Object.fromEntries(
      r.suggestions.map((s) => [s.categoryId, s.amountCents]),
    )
    noHistory.value = r.suggestions.length === 0
    suggesting.value = true
  } catch {
    error.value = "Couldn't work out a suggestion."
  }
}
async function useSuggestion() {
  const items = suggestions.value
    .map((s) => ({ categoryId: s.categoryId, amountCents: suggestionAmounts.value[s.categoryId] }))
    .filter((i): i is { categoryId: string; amountCents: number } => (i.amountCents ?? 0) > 0)
  if (items.length === 0) return
  try {
    await host.api.put('/budget', { month: month.value, items })
    suggesting.value = false
    await load()
  } catch {
    error.value = "Couldn't save the budget. Please try again."
  }
}

onMounted(load)
</script>

<template>
  <div class="d-flex align-center mb-4 ga-2">
    <h1 class="text-h5 mr-auto">Budget</h1>
    <v-btn icon="mdi-chevron-left" variant="text" aria-label="Previous month" @click="go(-1)" />
    <span class="text-subtitle-1" style="min-width: 9rem; text-align: center">{{ title }}</span>
    <v-btn icon="mdi-chevron-right" variant="text" aria-label="Next month" @click="go(1)" />
  </div>

  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>
  <v-progress-linear v-if="loading && !budget" indeterminate />

  <template v-if="budget">
    <v-card v-if="budget.lines.length === 0" variant="outlined" class="pa-6 text-center">
      <p class="text-h6 mb-2">Plan your month</p>
      <p class="text-medium-emphasis mb-4">
        Pick the categories you want to keep an eye on and set a monthly amount for each.
      </p>
      <div v-if="host.canEdit" class="d-flex justify-center ga-2 flex-wrap">
        <v-btn color="primary" @click="openSuggest">Suggest a budget from the last 3 months</v-btn>
        <v-btn variant="text" :disabled="budget.available.length === 0" @click="openAdd"
          >Add a category</v-btn
        >
      </div>
    </v-card>

    <template v-else>
      <v-card variant="outlined" class="pa-4 mb-4">
        <div class="d-flex align-baseline ga-2 flex-wrap">
          <span class="text-h5" data-testid="total-left">
            <v-icon
              :icon="
                budget.totals.leftCents < 0
                  ? 'mdi-alert-circle-outline'
                  : 'mdi-check-circle-outline'
              "
              size="small"
              aria-hidden="true"
            />
            {{ money(Math.abs(budget.totals.leftCents)) }}
            {{ budget.totals.leftCents < 0 ? 'over' : 'left to spend' }}
          </span>
          <span class="text-medium-emphasis"
            >{{ money(budget.totals.spentCents) }} spent of
            {{ money(budget.totals.budgetedCents) }}</span
          >
        </div>
      </v-card>

      <v-list lines="two" class="py-0">
        <v-list-item v-for="l in budget.lines" :key="l.categoryId" class="px-0">
          <div class="d-flex align-center ga-2">
            <span class="font-weight-medium mr-auto">{{ l.name }}</span>
            <span :class="l.leftCents < 0 ? 'text-error' : ''" data-testid="line-left">
              <v-icon
                v-if="l.leftCents < 0"
                icon="mdi-alert-circle-outline"
                size="x-small"
                aria-hidden="true"
              />
              {{ money(Math.abs(l.leftCents)) }} {{ l.leftCents < 0 ? 'over' : 'left' }}
            </span>
            <v-btn
              v-if="host.canEdit"
              icon="mdi-pencil-outline"
              size="small"
              variant="text"
              :aria-label="`Change the ${l.name} budget`"
              @click="openEdit(l)"
            />
          </div>
          <v-progress-linear
            :model-value="percent(l)"
            :color="l.leftCents < 0 ? 'error' : 'secondary'"
            height="8"
            rounded
            class="my-1"
            :aria-label="`${l.name}: ${money(l.spentCents)} spent of ${money(l.budgetedCents)}`"
          />
          <div class="text-caption text-medium-emphasis">
            {{ money(l.spentCents) }} spent of {{ money(l.budgetedCents) }}
          </div>
        </v-list-item>
      </v-list>
      <v-btn
        v-if="host.canEdit && budget.available.length > 0"
        variant="text"
        prepend-icon="mdi-plus"
        class="mt-2"
        @click="openAdd"
        >Add a category</v-btn
      >
    </template>
  </template>

  <v-dialog v-model="editing" max-width="420">
    <v-card :title="isNew ? 'Add a category' : `${editName} budget`">
      <v-card-text>
        <v-select
          v-if="isNew"
          v-model="editCategory"
          :items="budget?.available ?? []"
          item-title="name"
          item-value="id"
          label="Category"
        />
        <MoneyField v-model="editAmount" label="Per month" />
        <p class="text-caption text-medium-emphasis">
          This applies from {{ title }} on, and keeps going until you change it.
        </p>
      </v-card-text>
      <v-card-actions>
        <v-btn v-if="!isNew" color="error" variant="text" @click="save(0)">Stop tracking</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="editing = false">Cancel</v-btn>
        <v-btn color="primary" :disabled="!editCategory || !editAmount" @click="save(editAmount)"
          >Save</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="suggesting" max-width="480">
    <v-card title="Suggested budget">
      <v-card-text>
        <p v-if="noHistory" class="text-medium-emphasis">
          There isn't enough spending in the last 3 months to suggest anything yet. You can add a
          category by hand instead.
        </p>
        <template v-else>
          <p class="text-medium-emphasis mb-3">
            Based on what you spent on average in the last 3 months. Change any amount you like.
          </p>
          <MoneyField
            v-for="s in suggestions"
            :key="s.categoryId"
            v-model="suggestionAmounts[s.categoryId]!"
            :label="s.name"
          />
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="suggesting = false">Cancel</v-btn>
        <v-btn v-if="!noHistory" color="primary" @click="useSuggestion">Use this budget</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
