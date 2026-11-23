<script setup lang="ts">
import {
  dateFormats,
  MAX_CSV_CHARS,
  type AccountView,
  type ColumnMap,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportResult,
} from '@pond/shared'
import { computed, ref, watch } from 'vue'
import { DataTable, FormDialog, MoneyAmount } from '../common'
import { useAction } from '../../composables/useAction'
import { useSpaceApi } from '../../composables/useSpaceApi'

/**
 * Import a bank CSV in three steps: choose an account and file, tell Pond which column is which, then
 * review every row (duplicates are flagged and unchecked) before anything is saved.
 */
const props = defineProps<{ accounts: AccountView[] }>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ imported: [] }>()

const space = useSpaceApi()
const { busy, error, run } = useAction()

type Step = 'file' | 'map' | 'review' | 'done'
const step = ref<Step>('file')
const accountId = ref<string | null>(null)
const filename = ref('')
const csv = ref('')
const preview = ref<ImportPreview | null>(null)
const mapping = ref<ColumnMap | null>(null)
const skip = ref<Set<number>>(new Set())
const includeDup = ref<Set<number>>(new Set())
const page = ref(1)
const result = ref<ImportResult | null>(null)
const PER_PAGE = 50

watch(open, (isOpen) => {
  if (!isOpen) return
  step.value = 'file'
  accountId.value = props.accounts[0]?.id ?? null
  filename.value = ''
  csv.value = ''
  preview.value = null
  mapping.value = null
  skip.value = new Set()
  includeDup.value = new Set()
  page.value = 1
  result.value = null
  error.value = ''
})

// ---------- Step 1: file ----------
async function onFile(files: File | File[] | null | undefined) {
  const file = Array.isArray(files) ? files[0] : files
  if (!file) return
  error.value = ''
  if (file.size > MAX_CSV_CHARS) {
    error.value = 'That file is too large (6 MB limit). Split it into smaller files.'
    return
  }
  filename.value = file.name
  csv.value = await file.text()
}

async function loadPreview(withMapping: boolean) {
  const r = await run(() =>
    space.post<{ preview: ImportPreview }>('/imports/preview', {
      accountId: accountId.value,
      csv: csv.value,
      ...(withMapping && mapping.value ? { mapping: mapping.value } : {}),
    }),
  )
  if (r) preview.value = r.preview
  return !!r
}

async function toMap() {
  if (!(await loadPreview(false))) return
  mapping.value = preview.value?.suggestedMapping ?? {
    hasHeader: true,
    dateColumn: 0,
    dateFormat: 'YYYY-MM-DD',
    descriptionColumn: 1,
    amount: { mode: 'single', column: 2, invert: false },
  }
  step.value = 'map'
}

// ---------- Step 2: map columns ----------
const columnItems = computed(() => {
  const p = preview.value
  if (!p) return []
  return Array.from({ length: p.columnCount }, (_, i) => ({
    title: `Column ${i + 1}${p.headers?.[i] ? `: ${p.headers[i]}` : p.sampleRows[0]?.[i] ? ` (${p.sampleRows[0][i]!.slice(0, 18)})` : ''}`,
    value: i,
  }))
})
const dateFormatItems = dateFormats.map((f) => ({ title: f, value: f }))
const amountMode = computed({
  get: () => mapping.value?.amount.mode ?? 'single',
  set: (m: 'single' | 'split') => {
    if (!mapping.value) return
    mapping.value.amount =
      m === 'single'
        ? { mode: 'single', column: 2, invert: false }
        : { mode: 'split', debitColumn: 2, creditColumn: 3 }
  },
})
const single = computed(() =>
  mapping.value?.amount.mode === 'single' ? mapping.value.amount : null,
)
const split = computed(() => (mapping.value?.amount.mode === 'split' ? mapping.value.amount : null))

let timer: ReturnType<typeof setTimeout> | undefined
watch(
  mapping,
  () => {
    if (step.value !== 'map' || !mapping.value) return
    clearTimeout(timer)
    timer = setTimeout(() => loadPreview(true), 300)
  },
  { deep: true },
)

async function toReview() {
  if (!(await loadPreview(true))) return
  skip.value = new Set()
  includeDup.value = new Set()
  page.value = 1
  step.value = 'review'
}

// ---------- Step 3: review ----------
const rows = computed(() => preview.value?.rows ?? [])
const pageRows = computed(() =>
  rows.value.slice((page.value - 1) * PER_PAGE, page.value * PER_PAGE),
)
const isChecked = (r: ImportPreviewRow) =>
  r.status === 'invalid'
    ? false
    : r.status === 'duplicate'
      ? includeDup.value.has(r.rowNumber)
      : !skip.value.has(r.rowNumber)
function toggle(r: ImportPreviewRow) {
  if (r.status === 'invalid') return
  const isDup = r.status === 'duplicate'
  const set = new Set(isDup ? includeDup.value : skip.value)
  if (set.has(r.rowNumber)) set.delete(r.rowNumber)
  else set.add(r.rowNumber)
  if (isDup) includeDup.value = set
  else skip.value = set
}
const toImport = computed(() => rows.value.filter(isChecked).length)

const headers = [
  { title: 'Import', key: 'include', sortable: false, width: '80px' },
  { title: 'Date', key: 'date', width: '120px' },
  { title: 'Description', key: 'description' },
  { title: 'Amount', key: 'amount', align: 'end' as const, sortable: false },
  { title: 'Status', key: 'status', sortable: false, width: '170px' },
]

async function commit() {
  const r = await run(() =>
    space.post<{ result: ImportResult }>('/imports', {
      accountId: accountId.value,
      filename: filename.value,
      csv: csv.value,
      mapping: mapping.value,
      skipRows: [...skip.value],
      includeDuplicateRows: [...includeDup.value],
    }),
  )
  if (r) {
    result.value = r.result
    step.value = 'done'
    emit('imported')
  }
}

const title = computed(
  () =>
    ({
      file: 'Import a CSV: choose a file',
      map: 'Import a CSV: match the columns',
      review: 'Import a CSV: review',
      done: 'Import finished',
    })[step.value],
)
const submit = () =>
  step.value === 'file'
    ? toMap()
    : step.value === 'map'
      ? toReview()
      : step.value === 'review'
        ? commit()
        : (open.value = false)
const submitLabel = computed(
  () =>
    ({ file: 'Next', map: 'Review rows', review: `Import ${toImport.value} rows`, done: 'Close' })[
      step.value
    ],
)
const submitDisabled = computed(() => {
  if (step.value === 'file') return !accountId.value || !csv.value
  if (step.value === 'review') return toImport.value === 0
  return false
})
</script>

<template>
  <FormDialog
    v-model="open"
    :title="title"
    :submit-label="submitLabel"
    :busy="busy"
    :error="error"
    :submit-disabled="submitDisabled"
    :max-width="900"
    @submit="submit"
  >
    <!-- Step 1 -->
    <template v-if="step === 'file'">
      <p class="text-body-2 mb-4">
        Export your transactions from your bank as a CSV file, then choose it here. Nothing is saved
        until you have reviewed the rows.
      </p>
      <v-select
        v-model="accountId"
        :items="accounts.map((a) => ({ title: a.name, value: a.id }))"
        label="Import into account"
      />
      <v-file-input
        label="CSV file"
        accept=".csv,text/csv,text/plain"
        prepend-icon=""
        prepend-inner-icon="mdi-paperclip"
        @update:model-value="onFile"
      />
      <p v-if="csv" class="text-caption text-medium-emphasis">
        {{ filename }}: {{ csv.length < 1024 ? 'under 1' : (csv.length / 1024).toFixed(0) }} KB
        read.
      </p>
    </template>

    <!-- Step 2 -->
    <template v-else-if="step === 'map' && mapping && preview">
      <p class="text-body-2 mb-3">
        Tell Pond which column holds what. The preview below updates as you change things.
      </p>
      <v-switch
        v-model="mapping.hasHeader"
        label="The first row is a header"
        color="secondary"
        hide-details
        density="compact"
      />
      <div class="d-flex ga-3 flex-wrap mt-2">
        <v-select
          v-model="mapping.dateColumn"
          :items="columnItems"
          label="Date column"
          style="min-width: 220px; flex: 1"
        />
        <v-select
          v-model="mapping.dateFormat"
          :items="dateFormatItems"
          label="Date format"
          style="min-width: 180px; flex: 1"
        />
        <v-select
          v-model="mapping.descriptionColumn"
          :items="columnItems"
          label="Description column"
          style="min-width: 220px; flex: 1"
        />
      </div>
      <v-radio-group v-model="amountMode" inline label="Amounts are in" hide-details class="mb-2">
        <v-radio label="One column (negative = money out)" value="single" />
        <v-radio label="Separate money-out and money-in columns" value="split" />
      </v-radio-group>
      <div v-if="single" class="d-flex ga-3 align-center flex-wrap">
        <v-select
          v-model="single.column"
          :items="columnItems"
          label="Amount column"
          style="min-width: 220px; flex: 1"
        />
        <v-switch
          v-model="single.invert"
          label="Flip signs (this bank lists purchases as positive)"
          color="secondary"
          hide-details
          density="compact"
          style="flex: 2"
        />
      </div>
      <div v-else-if="split" class="d-flex ga-3 flex-wrap">
        <v-select
          v-model="split.debitColumn"
          :items="columnItems"
          label="Money out column"
          style="min-width: 220px; flex: 1"
        />
        <v-select
          v-model="split.creditColumn"
          :items="columnItems"
          label="Money in column"
          style="min-width: 220px; flex: 1"
        />
      </div>
      <div v-if="preview.rows.length" class="mt-3 text-body-2" role="status">
        {{ preview.counts.total }} rows: {{ preview.counts.new }} new,
        {{ preview.counts.duplicate }} look like duplicates, {{ preview.counts.invalid }} can't be
        read.
      </div>
      <v-table density="compact" class="mt-2">
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Date</th>
            <th scope="col">Description</th>
            <th scope="col" class="text-end">Amount</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in preview.rows.slice(0, 5)" :key="r.rowNumber">
            <td>{{ r.rowNumber }}</td>
            <td>{{ r.date ?? '' }}</td>
            <td>{{ r.description }}</td>
            <td class="text-end">
              <MoneyAmount v-if="r.amountCents !== null" :cents="r.amountCents" />
            </td>
            <td>{{ r.problem ?? (r.status === 'duplicate' ? 'Looks like a duplicate' : 'OK') }}</td>
          </tr>
        </tbody>
      </v-table>
    </template>

    <!-- Step 3 -->
    <template v-else-if="step === 'review' && preview">
      <p class="text-body-2 mb-3" role="status">
        {{ preview.counts.new }} new · {{ preview.counts.duplicate }} look like duplicates
        (unchecked) · {{ preview.counts.invalid }} can't be read (skipped). Uncheck anything you
        don't want, or check a duplicate to import it anyway.
      </p>
      <DataTable
        v-model:page="page"
        :headers="headers"
        :items="pageRows"
        :total="rows.length"
        :items-per-page="PER_PAGE"
        paged
        empty-text="No rows."
      >
        <template #item.include="{ item }">
          <v-checkbox-btn
            :model-value="isChecked(item)"
            :disabled="item.status === 'invalid'"
            :aria-label="`Import row ${item.rowNumber}`"
            @update:model-value="toggle(item)"
          />
        </template>
        <template #item.date="{ item }">{{ item.date ?? '' }}</template>
        <template #item.amount="{ item }"
          ><MoneyAmount v-if="item.amountCents !== null" :cents="item.amountCents"
        /></template>
        <template #item.status="{ item }">
          <v-chip v-if="item.status === 'new'" size="x-small" prepend-icon="mdi-plus">New</v-chip>
          <v-chip
            v-else-if="item.status === 'duplicate'"
            size="x-small"
            color="warning"
            prepend-icon="mdi-content-copy"
            >Duplicate</v-chip
          >
          <v-chip v-else size="x-small" color="error" prepend-icon="mdi-alert-outline">{{
            item.problem
          }}</v-chip>
        </template>
      </DataTable>
    </template>

    <!-- Done -->
    <template v-else-if="step === 'done' && result">
      <v-alert type="success" variant="tonal" role="status">
        Imported {{ result.imported }} transactions.
        <template v-if="result.rulesApplied">
          Your rules categorized {{ result.rulesApplied }} of them.</template
        >
      </v-alert>
      <p class="mt-3 text-body-2">
        {{ result.duplicatesSkipped }} duplicates left out · {{ result.skipped }} unchecked ·
        {{ result.invalid }} unreadable.
      </p>
    </template>

    <template #actions-left>
      <v-btn v-if="step === 'map'" variant="text" @click="step = 'file'">Back</v-btn>
      <v-btn v-else-if="step === 'review'" variant="text" @click="step = 'map'">Back</v-btn>
    </template>
  </FormDialog>
</template>
