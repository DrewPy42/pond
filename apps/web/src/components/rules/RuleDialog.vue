<script setup lang="ts">
import type {
  AccountView,
  CategoryView,
  RuleAction,
  RuleCondition,
  RuleView,
  TransactionView,
} from '@pond/shared'
import { computed, ref, watch } from 'vue'
import { api } from '../../api'
import { FormDialog, MoneyAmount, MoneyInput } from '../common'
import { useAction } from '../../composables/useAction'
import { useSpaceApi } from '../../composables/useSpaceApi'
import { useSpacesStore } from '../../stores/spaces'

/**
 * Create or edit a rule. Conditions are joined by AND; actions all run. "Test" shows how many of the
 * Space's recent transactions the conditions would match before anything is saved.
 */
const props = defineProps<{
  rule: RuleView | null
  accounts: AccountView[]
  categories: CategoryView[]
}>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ saved: [] }>()

const space = useSpaceApi()
const spacesStore = useSpacesStore()
const { busy, error, run } = useAction()

interface CondRow {
  type: RuleCondition['type']
  field: 'description' | 'payee' | 'any'
  op: 'contains' | 'starts_with' | 'equals' | 'matches'
  value: string
  min: number | null
  max: number | null
  accountId: string | null
  direction: 'in' | 'out'
}
interface ActRow {
  type: RuleAction['type']
  payee: string
  categoryId: string | null
  spaceId: string | null
}
const blankCond = (): CondRow => ({
  type: 'text',
  field: 'description',
  op: 'contains',
  value: '',
  min: null,
  max: null,
  accountId: null,
  direction: 'out',
})
const blankAct = (): ActRow => ({
  type: 'set_category',
  payee: '',
  categoryId: null,
  spaceId: null,
})

const name = ref('')
const priority = ref(100)
const enabled = ref(true)
const conds = ref<CondRow[]>([blankCond()])
const acts = ref<ActRow[]>([blankAct()])
const test = ref<{ examined: number; matched: number; samples: TransactionView[] } | null>(null)

const condTypes = [
  { title: 'Text', value: 'text' },
  { title: 'Amount', value: 'amount' },
  { title: 'Account', value: 'account' },
  { title: 'Money direction', value: 'direction' },
]
const fields = [
  { title: 'Description', value: 'description' },
  { title: 'Payee', value: 'payee' },
  { title: 'Description or payee', value: 'any' },
]
const ops = [
  { title: 'contains', value: 'contains' },
  { title: 'starts with', value: 'starts_with' },
  { title: 'is exactly', value: 'equals' },
  { title: 'matches pattern (* and ?)', value: 'matches' },
]
const actTypes = [
  { title: 'Set category', value: 'set_category' },
  { title: 'Set payee', value: 'set_payee' },
  { title: 'Move to another Space', value: 'move_to_space' },
  { title: 'Mark reimbursable', value: 'mark_reimbursable' },
  { title: 'Link as transfer', value: 'link_transfer' },
]
const editableSpaces = computed(() =>
  spacesStore.spaces
    .filter((s) => s.role === 'owner' || s.role === 'editor')
    .map((s) => ({ title: s.name, value: s.id })),
)

// Categories of other Spaces (for a "move to Space" rule), loaded on demand.
const otherCats = ref<Record<string, CategoryView[]>>({})
async function loadCats(spaceId: string | null) {
  if (!spaceId || spaceId === space.spaceId.value || otherCats.value[spaceId]) return
  const r = await api<{ categories: CategoryView[] }>(`/api/spaces/${spaceId}/categories`)
  otherCats.value = { ...otherCats.value, [spaceId]: r.categories }
}
/** Categories a set_category action may pick: those of the Space the money ends up in. */
const targetSpaceId = computed(
  () => acts.value.find((a) => a.type === 'move_to_space')?.spaceId ?? space.spaceId.value,
)
const categoryItems = computed(() => {
  const list =
    targetSpaceId.value === space.spaceId.value
      ? props.categories
      : (otherCats.value[targetSpaceId.value ?? ''] ?? [])
  return list.map((c) => ({ title: c.name, value: c.id }))
})

watch(open, async (isOpen) => {
  if (!isOpen) return
  error.value = ''
  test.value = null
  const r = props.rule
  if (!r) {
    name.value = ''
    priority.value = 100
    enabled.value = true
    conds.value = [blankCond()]
    acts.value = [blankAct()]
    return
  }
  name.value = r.name
  priority.value = r.priority
  enabled.value = r.enabled
  conds.value = r.conditions.map((c) => ({
    ...blankCond(),
    type: c.type,
    ...(c.type === 'text' ? { field: c.field, op: c.op, value: c.value } : {}),
    ...(c.type === 'amount' ? { min: c.minCents ?? null, max: c.maxCents ?? null } : {}),
    ...(c.type === 'account' ? { accountId: c.accountId } : {}),
    ...(c.type === 'direction' ? { direction: c.direction } : {}),
  }))
  acts.value = r.actions.map((a) => ({
    ...blankAct(),
    type: a.type,
    ...(a.type === 'set_payee' ? { payee: a.payee } : {}),
    ...(a.type === 'set_category' ? { categoryId: a.categoryId } : {}),
    ...(a.type === 'move_to_space' ? { spaceId: a.spaceId } : {}),
  }))
  await loadCats(targetSpaceId.value)
})

function toCondition(c: CondRow): RuleCondition | null {
  switch (c.type) {
    case 'text':
      return c.value.trim()
        ? { type: 'text', field: c.field, op: c.op, value: c.value.trim() }
        : null
    case 'amount':
      if (c.min === null && c.max === null) return null
      return {
        type: 'amount',
        ...(c.min !== null ? { minCents: c.min } : {}),
        ...(c.max !== null ? { maxCents: c.max } : {}),
      }
    case 'account':
      return c.accountId ? { type: 'account', accountId: c.accountId } : null
    case 'direction':
      return { type: 'direction', direction: c.direction }
  }
}
function toAction(a: ActRow): RuleAction | null {
  switch (a.type) {
    case 'set_payee':
      return a.payee.trim() ? { type: 'set_payee', payee: a.payee.trim() } : null
    case 'set_category':
      return a.categoryId ? { type: 'set_category', categoryId: a.categoryId } : null
    case 'move_to_space':
      return a.spaceId ? { type: 'move_to_space', spaceId: a.spaceId } : null
    default:
      return { type: a.type } as RuleAction
  }
}
const builtConds = computed(() => conds.value.map(toCondition))
const builtActs = computed(() => acts.value.map(toAction))
const valid = computed(
  () =>
    name.value.trim() !== '' &&
    builtConds.value.length > 0 &&
    builtConds.value.every((c) => c !== null) &&
    builtActs.value.length > 0 &&
    builtActs.value.every((a) => a !== null),
)

async function runTest() {
  if (!builtConds.value.every((c) => c !== null)) return
  const r = await run(() =>
    space.post<{ examined: number; matched: number; samples: TransactionView[] }>(
      '/rules/preview',
      { conditions: builtConds.value },
    ),
  )
  if (r) test.value = r
}

async function save() {
  const body = {
    name: name.value.trim(),
    priority: priority.value,
    enabled: enabled.value,
    conditions: builtConds.value,
    actions: builtActs.value,
  }
  const done = await run(async () => {
    if (props.rule) await space.patch(`/rules/${props.rule.id}`, body)
    else await space.post('/rules', body)
    return true
  })
  if (done) {
    open.value = false
    emit('saved')
  }
}
const amountOf = (t: TransactionView) => (t.kind === 'full' ? t.amountCents : 0)
</script>

<template>
  <FormDialog
    v-model="open"
    :title="rule ? 'Edit rule' : 'Add rule'"
    :busy="busy"
    :error="error"
    :submit-disabled="!valid"
    :max-width="760"
    @submit="save"
  >
    <div class="d-flex ga-3 flex-wrap">
      <v-text-field v-model="name" label="Rule name" style="min-width: 240px; flex: 2" autofocus />
      <v-text-field
        v-model.number="priority"
        label="Priority"
        type="number"
        hint="Lower numbers run first"
        persistent-hint
        style="max-width: 160px"
      />
    </div>
    <v-switch
      v-model="enabled"
      label="Enabled"
      color="secondary"
      hide-details
      density="compact"
      class="mb-2"
    />

    <div class="text-subtitle-1 mt-2 mb-1">When a new transaction matches all of these</div>
    <div v-for="(c, i) in conds" :key="i" class="d-flex ga-2 align-start flex-wrap">
      <v-select
        v-model="c.type"
        :items="condTypes"
        label="Condition"
        density="compact"
        style="min-width: 150px; flex: 1"
      />
      <template v-if="c.type === 'text'">
        <v-select
          v-model="c.field"
          :items="fields"
          label="Look at"
          density="compact"
          style="min-width: 160px; flex: 1.2"
        />
        <v-select
          v-model="c.op"
          :items="ops"
          label="Test"
          density="compact"
          style="min-width: 170px; flex: 1.2"
        />
        <v-text-field
          v-model="c.value"
          label="Text"
          density="compact"
          style="min-width: 160px; flex: 1.5"
        />
      </template>
      <template v-else-if="c.type === 'amount'">
        <MoneyInput
          v-model="c.min"
          label="At least"
          :allow-negative="false"
          style="min-width: 140px; flex: 1"
        />
        <MoneyInput
          v-model="c.max"
          label="At most"
          :allow-negative="false"
          style="min-width: 140px; flex: 1"
        />
      </template>
      <v-select
        v-else-if="c.type === 'account'"
        v-model="c.accountId"
        :items="accounts.map((a) => ({ title: a.name, value: a.id }))"
        label="Account"
        density="compact"
        style="min-width: 200px; flex: 2"
      />
      <v-btn-toggle
        v-else
        v-model="c.direction"
        mandatory
        divided
        density="comfortable"
        color="primary"
        class="mb-5"
        aria-label="Direction"
      >
        <v-btn value="out">Money out</v-btn>
        <v-btn value="in">Money in</v-btn>
      </v-btn-toggle>
      <v-btn
        icon="mdi-close"
        variant="text"
        aria-label="Remove condition"
        :disabled="conds.length <= 1"
        @click="conds.splice(i, 1)"
      />
    </div>
    <div class="d-flex align-center ga-3 mb-2">
      <v-btn variant="text" size="small" prepend-icon="mdi-plus" @click="conds.push(blankCond())"
        >Add condition</v-btn
      >
      <v-btn
        variant="text"
        size="small"
        prepend-icon="mdi-flask-outline"
        :disabled="!builtConds.every((c) => c !== null)"
        @click="runTest"
        >Test on recent transactions</v-btn
      >
    </div>
    <v-alert v-if="test" type="info" variant="tonal" density="compact" class="mb-3" role="status">
      Would match {{ test.matched }} of {{ test.examined }} recent transactions.
      <ul v-if="test.samples.length" class="mt-1 pl-4">
        <li v-for="s in test.samples.slice(0, 5)" :key="s.id">
          {{ s.date }} · {{ s.descriptionRaw }} · <MoneyAmount :cents="amountOf(s)" plain />
        </li>
      </ul>
    </v-alert>

    <div class="text-subtitle-1 mt-2 mb-1">Do this</div>
    <div v-for="(a, i) in acts" :key="i" class="d-flex ga-2 align-start flex-wrap">
      <v-select
        v-model="a.type"
        :items="actTypes"
        label="Action"
        density="compact"
        style="min-width: 200px; flex: 1"
      />
      <v-text-field
        v-if="a.type === 'set_payee'"
        v-model="a.payee"
        label="Payee"
        density="compact"
        style="min-width: 200px; flex: 2"
      />
      <v-select
        v-else-if="a.type === 'set_category'"
        v-model="a.categoryId"
        :items="categoryItems"
        label="Category"
        density="compact"
        style="min-width: 200px; flex: 2"
      />
      <v-select
        v-else-if="a.type === 'move_to_space'"
        v-model="a.spaceId"
        :items="editableSpaces"
        label="Space"
        density="compact"
        style="min-width: 200px; flex: 2"
        @update:model-value="loadCats"
      />
      <span v-else class="text-body-2 text-medium-emphasis align-self-center" style="flex: 2">
        {{
          a.type === 'link_transfer'
            ? 'Links to the one matching opposite transaction on another account'
            : 'Marks the split as reimbursable'
        }}
      </span>
      <v-btn
        icon="mdi-close"
        variant="text"
        aria-label="Remove action"
        :disabled="acts.length <= 1"
        @click="acts.splice(i, 1)"
      />
    </div>
    <v-btn variant="text" size="small" prepend-icon="mdi-plus" @click="acts.push(blankAct())"
      >Add action</v-btn
    >
    <p class="text-caption text-medium-emphasis mt-3">
      Rules run on new transactions only, and never on ones you have edited. When several rules want
      the same change, the one with the lowest priority number wins.
    </p>
  </FormDialog>
</template>
