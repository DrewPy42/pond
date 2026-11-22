<script setup lang="ts">
import type { AccountView, CategoryView, FullTransactionView } from '@pond/shared'
import { sumCents } from '@pond/shared'
import { computed, ref, watch } from 'vue'
import { api } from '../../api'
import { FormDialog, MoneyAmount, MoneyInput } from '../common'
import { useAction } from '../../composables/useAction'
import { useSpaceApi } from '../../composables/useSpaceApi'
import { useSpacesStore } from '../../stores/spaces'
import LinkTransferDialog from './LinkTransferDialog.vue'

/**
 * Add or edit a manual transaction. Amounts are typed as positive numbers with a Money out /
 * Money in switch; splits are checked here (and again by the server) so the parts always add up
 * to the total before Save is enabled.
 */
const props = defineProps<{
  transaction: FullTransactionView | null
  accounts: AccountView[]
  categories: CategoryView[]
}>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ saved: [] }>()

const space = useSpaceApi()
const spacesStore = useSpacesStore()
const { busy, error, run } = useAction()

interface SplitRow {
  spaceId: string
  categoryId: string | null
  cents: number | null
  memo: string
}
const today = () => new Date().toISOString().slice(0, 10)
const blank = () => ({
  accountId: '' as string,
  date: today(),
  description: '',
  payee: '',
  memo: '',
  pending: false,
  isPrivate: false,
  direction: 'out' as 'out' | 'in',
  cents: null as number | null,
  splitMode: false,
  simpleCategory: null as string | null,
  rows: [] as SplitRow[],
})
const form = ref(blank())
const transfer = ref<{ id: string } | null>(null)
const linkOpen = ref(false)
const confirmDelete = ref(false)

const sign = computed(() => (form.value.direction === 'out' ? -1 : 1))
const remaining = computed(() => {
  if (form.value.cents === null) return null
  const parts = form.value.rows.map((r) => r.cents ?? 0)
  return form.value.cents - sumCents(parts)
})
const editableSpaces = computed(() =>
  spacesStore.spaces
    .filter((s) => s.role === 'owner' || s.role === 'editor')
    .map((s) => ({ title: s.name, value: s.id })),
)
const activeId = computed(() => space.spaceId.value ?? '')

// Categories of other Spaces, loaded on demand when a split points at them.
const catCache = ref<Record<string, CategoryView[]>>({})
async function categoriesFor(spaceId: string): Promise<CategoryView[]> {
  if (spaceId === activeId.value) return props.categories
  if (!catCache.value[spaceId]) {
    const r = await api<{ categories: CategoryView[] }>(`/api/spaces/${spaceId}/categories`)
    catCache.value = { ...catCache.value, [spaceId]: r.categories }
  }
  return catCache.value[spaceId]!
}
const categoryItems = (spaceId: string) =>
  (spaceId === activeId.value ? props.categories : (catCache.value[spaceId] ?? [])).map((c) => ({
    title: c.name,
    value: c.id,
  }))

watch(open, async (isOpen) => {
  if (!isOpen) return
  error.value = ''
  confirmDelete.value = false
  transfer.value = null
  const t = props.transaction
  if (!t) {
    form.value = { ...blank(), accountId: props.accounts[0]?.id ?? '' }
    return
  }
  const dir = t.amountCents < 0 ? 'out' : 'in'
  const simple = t.splits.length === 1 && t.splits[0]!.spaceId === activeId.value
  form.value = {
    accountId: t.accountId,
    date: t.date,
    description: t.descriptionRaw,
    payee: t.payee ?? '',
    memo: t.memo ?? '',
    pending: t.pending,
    isPrivate: t.private,
    direction: dir,
    cents: Math.abs(t.amountCents),
    splitMode: !simple,
    simpleCategory: simple ? t.splits[0]!.categoryId : null,
    rows: t.splits.map((s) => ({
      spaceId: s.spaceId,
      categoryId: s.categoryId,
      cents: Math.abs(s.amountCents),
      memo: s.memo ?? '',
    })),
  }
  for (const r of form.value.rows) await categoriesFor(r.spaceId)
  const detail = await run(() =>
    space.get<{ transfer: { id: string } | null }>(`/transactions/${t.id}`),
  )
  transfer.value = detail?.transfer ?? null
})

async function startSplit() {
  const f = form.value
  f.splitMode = true
  f.rows = [
    { spaceId: activeId.value, categoryId: f.simpleCategory, cents: f.cents, memo: '' },
    { spaceId: activeId.value, categoryId: null, cents: null, memo: '' },
  ]
  // Start the second row with what's left so the user only has to adjust.
  f.rows[0]!.cents = f.cents
}
function useOneCategory() {
  form.value.splitMode = false
  form.value.rows = []
}
function addRow() {
  form.value.rows.push({
    spaceId: activeId.value,
    categoryId: null,
    cents: remaining.value && remaining.value > 0 ? remaining.value : null,
    memo: '',
  })
}
async function onRowSpace(row: SplitRow) {
  row.categoryId = null
  await categoriesFor(row.spaceId)
}

const canSave = computed(() => {
  const f = form.value
  if (!f.accountId || !f.description.trim() || !f.cents || f.cents <= 0) return false
  if (!f.splitMode) return true
  return (
    f.rows.length >= 1 &&
    f.rows.every((r) => r.cents !== null && r.cents > 0) &&
    remaining.value === 0
  )
})

async function save() {
  const f = form.value
  const signed = sign.value * f.cents!
  const splits = f.splitMode
    ? f.rows.map((r) => ({
        spaceId: r.spaceId,
        categoryId: r.categoryId,
        amountCents: sign.value * r.cents!,
        memo: r.memo || null,
      }))
    : [{ spaceId: activeId.value, categoryId: f.simpleCategory, amountCents: signed }]
  const done = await run(async () => {
    if (props.transaction) {
      await space.patch(`/transactions/${props.transaction.id}`, {
        date: f.date,
        amountCents: signed,
        description: f.description.trim(),
        payee: f.payee.trim() || null,
        memo: f.memo.trim() || null,
        pending: f.pending,
        private: f.isPrivate,
        splits,
      })
    } else {
      await space.post('/transactions', {
        accountId: f.accountId,
        date: f.date,
        amountCents: signed,
        description: f.description.trim(),
        payee: f.payee.trim() || undefined,
        memo: f.memo.trim() || undefined,
        pending: f.pending,
        splits,
      })
    }
    return true
  })
  if (done) {
    open.value = false
    emit('saved')
  }
}

async function remove() {
  if (!confirmDelete.value) {
    confirmDelete.value = true
    return
  }
  const done = await run(async () => {
    await space.del(`/transactions/${props.transaction!.id}`)
    return true
  })
  if (done) {
    open.value = false
    emit('saved')
  }
}

async function unlink() {
  const done = await run(async () => {
    await space.del(`/transfers/${props.transaction!.id}`)
    return true
  })
  if (done) transfer.value = null
}
function afterLinked() {
  emit('saved')
  open.value = false
}
const money = (cents: number) => ({ cents })
</script>

<template>
  <FormDialog
    v-model="open"
    :title="transaction ? 'Edit transaction' : 'Add transaction'"
    :busy="busy"
    :error="error"
    :submit-disabled="!canSave"
    :max-width="680"
    @submit="save"
  >
    <v-select
      v-model="form.accountId"
      :items="accounts.map((a) => ({ title: a.name, value: a.id }))"
      label="Account"
      :disabled="!!transaction"
    />
    <div class="d-flex ga-3 flex-wrap">
      <v-text-field v-model="form.date" label="Date" type="date" style="max-width: 180px" />
      <v-btn-toggle
        v-model="form.direction"
        mandatory
        divided
        density="comfortable"
        class="mb-5"
        color="primary"
        aria-label="Direction"
      >
        <v-btn value="out" prepend-icon="mdi-arrow-top-right">Money out</v-btn>
        <v-btn value="in" prepend-icon="mdi-arrow-bottom-left">Money in</v-btn>
      </v-btn-toggle>
      <MoneyInput
        v-model="form.cents"
        label="Amount"
        :allow-negative="false"
        style="max-width: 200px"
      />
    </div>
    <v-text-field v-model="form.description" label="Description" />
    <v-text-field v-model="form.payee" label="Payee (optional)" />

    <template v-if="!form.splitMode">
      <v-select
        v-model="form.simpleCategory"
        :items="categoryItems(activeId)"
        label="Category"
        clearable
      />
      <v-btn
        variant="text"
        size="small"
        prepend-icon="mdi-call-split"
        :disabled="!form.cents"
        @click="startSplit"
        >Split this transaction</v-btn
      >
    </template>

    <template v-else>
      <div class="text-subtitle-2 mb-2">Splits</div>
      <div v-for="(row, i) in form.rows" :key="i" class="d-flex ga-2 align-start flex-wrap">
        <v-select
          v-model="row.spaceId"
          :items="editableSpaces"
          label="Space"
          style="min-width: 150px; flex: 1"
          @update:model-value="onRowSpace(row)"
        />
        <v-select
          v-model="row.categoryId"
          :items="categoryItems(row.spaceId)"
          label="Category"
          clearable
          style="min-width: 170px; flex: 1.2"
        />
        <MoneyInput
          v-model="row.cents"
          label="Amount"
          :allow-negative="false"
          style="min-width: 130px; flex: 0.8"
        />
        <v-btn
          icon="mdi-close"
          variant="text"
          aria-label="Remove split"
          :disabled="form.rows.length <= 1"
          @click="form.rows.splice(i, 1)"
        />
      </div>
      <div class="d-flex align-center ga-3 mb-2">
        <v-btn variant="text" size="small" prepend-icon="mdi-plus" @click="addRow">Add split</v-btn>
        <v-btn variant="text" size="small" @click="useOneCategory">Use one category</v-btn>
        <v-spacer />
        <span v-if="remaining === 0" class="text-body-2"
          ><v-icon icon="mdi-check" size="small" /> Adds up</span
        >
        <span v-else-if="remaining !== null" class="text-body-2" role="status">
          <MoneyAmount v-bind="money(remaining)" plain /> left to assign
        </span>
      </div>
    </template>

    <v-text-field v-model="form.memo" label="Memo (optional)" />
    <v-switch
      v-model="form.pending"
      label="Pending"
      color="secondary"
      hide-details
      density="compact"
    />
    <v-switch
      v-if="transaction"
      v-model="form.isPrivate"
      label="Private (hide account, total and other splits from other Spaces)"
      color="secondary"
      hide-details
      density="compact"
    />

    <div v-if="transaction" class="mt-4">
      <template v-if="transfer">
        <v-chip prepend-icon="mdi-swap-horizontal" class="mr-2">Linked transfer</v-chip>
        <v-btn variant="text" size="small" @click="unlink">Unlink</v-btn>
      </template>
      <v-btn
        v-else
        variant="text"
        size="small"
        prepend-icon="mdi-swap-horizontal"
        @click="linkOpen = true"
        >Link as transfer…</v-btn
      >
    </div>

    <template #actions-left>
      <v-btn
        v-if="transaction && transaction.source === 'manual'"
        variant="text"
        :color="confirmDelete ? 'error' : undefined"
        @click="remove"
      >
        {{ confirmDelete ? 'Click again to delete' : 'Delete' }}
      </v-btn>
    </template>
  </FormDialog>
  <LinkTransferDialog
    v-if="transaction"
    v-model="linkOpen"
    :transaction="transaction"
    @linked="afterLinked"
  />
</template>
