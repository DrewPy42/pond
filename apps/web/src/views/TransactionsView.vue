<script setup lang="ts">
import type { AccountView, CategoryView, FullTransactionView, TransactionView } from '@pond/shared'
import { sumCents } from '@pond/shared'
import { computed, onMounted, ref, watch } from 'vue'
import { DataTable, MoneyAmount } from '../components/common'
import ImportDialog from '../components/imports/ImportDialog.vue'
import TransactionDialog from '../components/ledger/TransactionDialog.vue'
import { useAction } from '../composables/useAction'
import { useSpaceApi } from '../composables/useSpaceApi'

const space = useSpaceApi()
const { busy, error, run } = useAction()

const accounts = ref<AccountView[]>([])
const categories = ref<CategoryView[]>([])
const rows = ref<TransactionView[]>([])
const total = ref(0)
const page = ref(1)
const perPage = 25
const filters = ref({ accountId: null as string | null, q: '', from: '', to: '' })

const importOpen = ref(false)
const editing = ref<FullTransactionView | null>(null)
const dialogOpen = ref(false)

const headers = [
  { title: 'Date', key: 'date', width: '120px' },
  { title: 'Description', key: 'description' },
  { title: 'Account', key: 'account' },
  { title: 'Category', key: 'category' },
  { title: 'Amount', key: 'amount', align: 'end' as const, sortable: false },
]
const categoryName = computed(() => new Map(categories.value.map((c) => [c.id, c.name])))
const currencyOf = (t: TransactionView) =>
  t.kind === 'full'
    ? (accounts.value.find((a) => a.id === t.accountId)?.currency ?? space.currency.value)
    : space.currency.value

function categoryText(t: TransactionView): string {
  if (t.splits.length === 0) return ''
  if (t.splits.length > 1) return `Split (${t.splits.length})`
  const id = t.splits[0]!.categoryId
  return id ? (categoryName.value.get(id) ?? 'Other Space') : 'Uncategorized'
}
/** In this Space: the whole amount for our own transactions, only our share for shared ones. */
const amountHere = (t: TransactionView) =>
  t.kind === 'full' ? t.amountCents : sumCents(t.splits.map((s) => s.amountCents))

async function loadLookups() {
  if (!space.spaceId.value) return
  const [a, c] = await Promise.all([
    space.get<{ accounts: AccountView[] }>('/accounts'),
    space.get<{ categories: CategoryView[] }>('/categories'),
  ])
  accounts.value = a.accounts
  categories.value = c.categories
}

async function load() {
  if (!space.spaceId.value) return
  const f = filters.value
  const params = new URLSearchParams({
    limit: String(perPage),
    offset: String((page.value - 1) * perPage),
  })
  if (f.accountId) params.set('accountId', f.accountId)
  if (f.q.trim()) params.set('q', f.q.trim())
  if (f.from) params.set('from', f.from)
  if (f.to) params.set('to', f.to)
  const r = await run(() =>
    space.get<{ transactions: TransactionView[]; total: number }>(`/transactions?${params}`),
  )
  if (r) {
    rows.value = r.transactions
    total.value = r.total
  }
}

onMounted(async () => {
  await loadLookups()
  await load()
})
watch(space.spaceId, async () => {
  page.value = 1
  filters.value = { accountId: null, q: '', from: '', to: '' }
  await loadLookups()
  await load()
})
watch(page, load)
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  filters,
  () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      page.value = 1
      load()
    }, 250)
  },
  { deep: true },
)

const add = () => {
  editing.value = null
  dialogOpen.value = true
}
const open = (t: TransactionView) => {
  if (t.kind !== 'full' || !space.canEdit.value) return
  editing.value = t
  dialogOpen.value = true
}
async function saved() {
  await loadLookups()
  await load()
}
</script>

<template>
  <div class="d-flex align-center mb-4 ga-3 flex-wrap">
    <h1 class="text-h5">Transactions</h1>
    <v-spacer />
    <v-btn
      v-if="space.canEdit.value"
      variant="outlined"
      prepend-icon="mdi-file-upload-outline"
      :disabled="accounts.length === 0"
      @click="importOpen = true"
    >
      Import CSV
    </v-btn>
    <v-btn
      v-if="space.canEdit.value"
      color="primary"
      prepend-icon="mdi-plus"
      :disabled="accounts.length === 0"
      @click="add"
    >
      Add transaction
    </v-btn>
  </div>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{
    error
  }}</v-alert>
  <v-alert
    v-if="space.canEdit.value && accounts.length === 0 && space.spaceId.value"
    type="info"
    variant="tonal"
    density="compact"
    class="mb-4"
  >
    Add an account first, then you can enter transactions.
  </v-alert>

  <v-row dense class="mb-2">
    <v-col cols="12" md="4">
      <v-text-field
        v-model="filters.q"
        label="Search"
        prepend-inner-icon="mdi-magnify"
        clearable
        hide-details
        density="compact"
      />
    </v-col>
    <v-col cols="12" md="3">
      <v-select
        v-model="filters.accountId"
        :items="accounts.map((a) => ({ title: a.name, value: a.id }))"
        label="Account"
        clearable
        hide-details
        density="compact"
      />
    </v-col>
    <v-col cols="6" md="2"
      ><v-text-field v-model="filters.from" label="From" type="date" hide-details density="compact"
    /></v-col>
    <v-col cols="6" md="2"
      ><v-text-field v-model="filters.to" label="To" type="date" hide-details density="compact"
    /></v-col>
  </v-row>

  <DataTable
    v-model:page="page"
    :headers="headers"
    :items="rows"
    :total="total"
    :loading="busy"
    :items-per-page="perPage"
    paged
    clickable
    empty-text="No transactions match."
    @row-click="open"
  >
    <template #item.description="{ item }">
      <div>{{ item.descriptionRaw }}</div>
      <div v-if="item.payee" class="text-caption text-medium-emphasis">{{ item.payee }}</div>
      <v-chip v-if="item.pending" size="x-small" class="mt-1">Pending</v-chip>
    </template>
    <template #item.account="{ item }">
      <template v-if="item.kind === 'full'">{{ item.accountName }}</template>
      <template v-else>
        <v-chip size="x-small" prepend-icon="mdi-share-variant-outline">Shared</v-chip>
        <span class="ml-1 text-medium-emphasis">{{
          item.accountName ?? 'An account in another Space'
        }}</span>
      </template>
    </template>
    <template #item.category="{ item }">{{ categoryText(item) }}</template>
    <template #item.amount="{ item }">
      <MoneyAmount :cents="amountHere(item)" :currency="currencyOf(item)" />
      <div
        v-if="item.kind === 'shared' && item.totalCents !== null"
        class="text-caption text-medium-emphasis"
      >
        of <MoneyAmount :cents="item.totalCents" :currency="currencyOf(item)" plain />
      </div>
    </template>
  </DataTable>

  <ImportDialog v-model="importOpen" :accounts="accounts" @imported="saved" />
  <TransactionDialog
    v-model="dialogOpen"
    :transaction="editing"
    :accounts="accounts"
    :categories="categories"
    @saved="saved"
  />
</template>
