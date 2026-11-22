<script setup lang="ts">
import type { AccountView } from '@pond/shared'
import { onMounted, ref, watch } from 'vue'
import { MoneyAmount } from '../components/common'
import AccountDialog from '../components/ledger/AccountDialog.vue'
import BalanceDialog from '../components/ledger/BalanceDialog.vue'
import { useAction } from '../composables/useAction'
import { useSpaceApi } from '../composables/useSpaceApi'

const space = useSpaceApi()
const { busy, error, run } = useAction()
const accounts = ref<AccountView[]>([])
const showArchived = ref(false)
const editing = ref<AccountView | null>(null)
const accountOpen = ref(false)
const balanceFor = ref<AccountView | null>(null)
const balanceOpen = ref(false)

const typeLabel = (t: string) => t.replace('_', ' ').replace(/^./, (c) => c.toUpperCase())

async function load() {
  if (!space.spaceId.value) return
  const r = await run(() =>
    space.get<{ accounts: AccountView[] }>(`/accounts?includeArchived=${showArchived.value}`),
  )
  if (r) accounts.value = r.accounts
}
onMounted(load)
watch([space.spaceId, showArchived], load)

const edit = (a: AccountView | null) => {
  editing.value = a
  accountOpen.value = true
}
const recordBalance = (a: AccountView) => {
  balanceFor.value = a
  balanceOpen.value = true
}
async function archive(a: AccountView) {
  await run(() => space.patch(`/accounts/${a.id}`, { archived: !a.archived }))
  await load()
}
</script>

<template>
  <div class="d-flex align-center mb-4 ga-3 flex-wrap">
    <h1 class="text-h5">Accounts</h1>
    <v-spacer />
    <v-switch
      v-model="showArchived"
      label="Show archived"
      density="compact"
      hide-details
      color="secondary"
    />
    <v-btn v-if="space.canEdit.value" color="primary" prepend-icon="mdi-plus" @click="edit(null)"
      >Add account</v-btn
    >
  </div>

  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{
    error
  }}</v-alert>
  <p v-if="!space.spaceId.value" class="text-medium-emphasis">
    Choose a Space to see its accounts.
  </p>
  <p v-else-if="!busy && accounts.length === 0" class="text-medium-emphasis">
    No accounts yet. Add one to start tracking transactions and balances.
  </p>

  <v-row>
    <v-col v-for="a in accounts" :key="a.id" cols="12" md="6" lg="4">
      <v-card border flat :class="{ 'opacity-60': a.archived }">
        <v-card-title class="d-flex align-center">
          <span class="text-truncate">{{ a.nickname || a.name }}</span>
          <v-chip v-if="a.archived" size="x-small" class="ml-2">Archived</v-chip>
        </v-card-title>
        <v-card-subtitle>
          {{ typeLabel(a.type)
          }}<template v-if="a.institutionName"> · {{ a.institutionName }}</template
          ><template v-if="a.lastFour"> · …{{ a.lastFour }}</template>
        </v-card-subtitle>
        <v-card-text>
          <div class="text-h6">
            <MoneyAmount
              v-if="a.balanceCents !== null"
              :cents="a.balanceCents"
              :currency="a.currency"
              plain
            />
            <span v-else class="text-medium-emphasis text-body-1">No balance recorded</span>
          </div>
          <div v-if="a.balanceDate" class="text-caption text-medium-emphasis">
            as of {{ a.balanceDate }}
          </div>
        </v-card-text>
        <v-card-actions v-if="space.canEdit.value">
          <v-btn variant="text" size="small" @click="recordBalance(a)">Record balance</v-btn>
          <v-btn variant="text" size="small" @click="edit(a)">Edit</v-btn>
          <v-spacer />
          <v-btn variant="text" size="small" @click="archive(a)">{{
            a.archived ? 'Restore' : 'Archive'
          }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-col>
  </v-row>

  <AccountDialog v-model="accountOpen" :account="editing" @saved="load" />
  <BalanceDialog v-model="balanceOpen" :account="balanceFor" @saved="load" />
</template>
