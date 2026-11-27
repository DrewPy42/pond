<script setup lang="ts">
import { usePadHost } from '@pond/sdk/client'
import { formatMoney } from '@pond/shared'
import { onMounted, ref } from 'vue'
import { monthlyNeededCents, today } from './logic'
import MoneyField from './MoneyField.vue'

interface Goal {
  id: string
  name: string
  targetCents: number
  targetDate: string | null
  accountId: string | null
  accountName: string | null
  savedCents: number
  percent: number
  reached: boolean
  contributions: { id: string; date: string; amountCents: number }[]
}

const host = usePadHost()
const goals = ref<Goal[]>([])
const accounts = ref<{ id: string; name: string }[]>([])
const error = ref('')
const loading = ref(true)
const money = (cents: number) => formatMoney(cents)
const needed = (g: Goal) => monthlyNeededCents(g.targetCents, g.savedCents, g.targetDate, today())

async function load() {
  try {
    goals.value = (await host.api.get<{ goals: Goal[] }>('/goals')).goals
    error.value = ''
  } catch {
    error.value = "Couldn't load your goals."
  } finally {
    loading.value = false
  }
}
async function run(action: () => Promise<unknown>) {
  try {
    await action()
    error.value = ''
  } catch {
    error.value = "Couldn't save that. Please try again."
  }
  await load()
}

// ----- new goal -----
const adding = ref(false)
const name = ref('')
const target = ref<number | null>(null)
const date = ref('')
const source = ref<'account' | 'manual'>('manual')
const accountId = ref<string | null>(null)

async function openAdd() {
  name.value = ''
  target.value = null
  date.value = ''
  source.value = 'manual'
  accountId.value = null
  adding.value = true
  try {
    accounts.value = (
      await host.api.get<{ accounts: { id: string; name: string }[] }>('/accounts')
    ).accounts
  } catch {
    accounts.value = []
  }
}
async function create() {
  if (!name.value.trim() || !target.value) return
  await run(() =>
    host.api.post('/goals', {
      name: name.value,
      targetCents: target.value,
      targetDate: date.value || null,
      accountId: source.value === 'account' ? accountId.value : null,
    }),
  )
  adding.value = false
}

// ----- add money to a goal -----
const contributing = ref<Goal | null>(null)
const amount = ref<number | null>(null)
const when = ref(today())
function openContribute(g: Goal) {
  contributing.value = g
  amount.value = null
  when.value = today()
}
async function contribute() {
  const g = contributing.value
  if (!g || !amount.value) return
  await run(() =>
    host.api.post(`/goals/${g.id}/contributions`, { amountCents: amount.value, date: when.value }),
  )
  contributing.value = null
}

// ----- remove -----
const removing = ref<Goal | null>(null)
async function remove() {
  const g = removing.value
  if (!g) return
  await run(() => host.api.del(`/goals/${g.id}`))
  removing.value = null
}

onMounted(load)
</script>

<template>
  <div class="d-flex align-center mb-4">
    <h1 class="text-h5 mr-auto">Goals</h1>
    <v-btn v-if="host.canEdit" color="primary" prepend-icon="mdi-plus" @click="openAdd"
      >New goal</v-btn
    >
  </div>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>
  <v-progress-linear v-if="loading" indeterminate />
  <p v-else-if="goals.length === 0" class="text-medium-emphasis">
    No goals yet. A goal is something you're saving toward, like a trip or an emergency fund.
  </p>

  <v-card v-for="g in goals" :key="g.id" variant="outlined" class="pa-4 mb-3">
    <div class="d-flex align-center ga-2">
      <span class="text-h6 mr-auto">{{ g.name }}</span>
      <span v-if="g.reached" class="text-medium-emphasis">
        <v-icon icon="mdi-check-circle-outline" size="small" aria-hidden="true" /> Goal reached
      </span>
      <v-btn
        v-if="host.canEdit"
        icon="mdi-delete-outline"
        size="small"
        variant="text"
        :aria-label="`Delete ${g.name}`"
        @click="removing = g"
      />
    </div>
    <v-progress-linear
      :model-value="g.percent"
      color="secondary"
      height="10"
      rounded
      class="my-2"
      :aria-label="`${g.name}: ${g.percent} percent saved`"
    />
    <div>
      {{ money(g.savedCents) }} of {{ money(g.targetCents) }}
      <span class="text-medium-emphasis">({{ g.percent }}%)</span>
    </div>
    <div v-if="g.targetDate && !g.reached" class="text-medium-emphasis text-body-2">
      <template v-if="needed(g) === null">The target date has passed.</template>
      <template v-else
        >By {{ g.targetDate }}: about {{ money(needed(g)!) }} a month to stay on track.</template
      >
    </div>
    <div v-if="g.accountId" class="text-medium-emphasis text-body-2">
      Counts the balance of {{ g.accountName ?? 'an account that is no longer shown' }}.
    </div>
    <template v-else>
      <div v-if="host.canEdit" class="mt-2">
        <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="openContribute(g)"
          >Add money</v-btn
        >
      </div>
      <v-list v-if="g.contributions.length" density="compact" class="py-0 mt-2">
        <v-list-item v-for="c in g.contributions" :key="c.id" class="px-0">
          <v-list-item-title>
            <v-icon
              :icon="c.amountCents < 0 ? 'mdi-arrow-top-right' : 'mdi-arrow-bottom-left'"
              size="x-small"
              aria-hidden="true"
            />
            {{ c.amountCents < 0 ? '-' : '+' }}{{ money(Math.abs(c.amountCents)) }}
            <span class="text-medium-emphasis ml-2">{{ c.date }}</span>
          </v-list-item-title>
          <template v-if="host.canEdit" #append>
            <v-btn
              icon="mdi-close"
              size="x-small"
              variant="text"
              :aria-label="`Remove the ${c.date} entry`"
              @click="run(() => host.api.del(`/goals/${g.id}/contributions/${c.id}`))"
            />
          </template>
        </v-list-item>
      </v-list>
    </template>
  </v-card>

  <v-dialog v-model="adding" max-width="440">
    <v-card title="New goal">
      <v-card-text>
        <v-text-field v-model="name" label="What are you saving for?" maxlength="80" />
        <MoneyField v-model="target" label="Target amount" />
        <v-text-field v-model="date" label="Target date (optional)" type="date" />
        <v-radio-group v-model="source" label="Track progress with">
          <v-radio label="Money I add myself" value="manual" />
          <v-radio label="An account's balance" value="account" :disabled="accounts.length === 0" />
        </v-radio-group>
        <v-select
          v-if="source === 'account'"
          v-model="accountId"
          :items="accounts"
          item-title="name"
          item-value="id"
          label="Account"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="adding = false">Cancel</v-btn>
        <v-btn
          color="primary"
          :disabled="!name.trim() || !target || (source === 'account' && !accountId)"
          @click="create"
          >Create goal</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="!!contributing" max-width="380" @update:model-value="contributing = null">
    <v-card :title="`Add money to ${contributing?.name ?? ''}`">
      <v-card-text>
        <MoneyField v-model="amount" label="Amount" allow-negative />
        <p class="text-caption text-medium-emphasis mt-n2 mb-3">
          Use a minus sign if you took money back out.
        </p>
        <v-text-field v-model="when" label="Date" type="date" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="contributing = null">Cancel</v-btn>
        <v-btn color="primary" :disabled="!amount || !when" @click="contribute">Add</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="!!removing" max-width="380" @update:model-value="removing = null">
    <v-card :title="`Delete ${removing?.name ?? ''}?`">
      <v-card-text
        >This removes the goal and any money you added to it. It can't be undone.</v-card-text
      >
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="removing = null">Keep it</v-btn>
        <v-btn color="error" @click="remove">Delete</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
