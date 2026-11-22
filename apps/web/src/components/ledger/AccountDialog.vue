<script setup lang="ts">
import { accountTypes, type AccountView } from '@pond/shared'
import { ref, watch } from 'vue'
import { FormDialog, MoneyInput } from '../common'
import { useAction } from '../../composables/useAction'
import { useSpaceApi } from '../../composables/useSpaceApi'

/** Create a manual account (optionally with an opening balance) or edit an existing one. */
const props = defineProps<{ account: AccountView | null }>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ saved: [] }>()

const space = useSpaceApi()
const { busy, error, run } = useAction()

const typeLabels: Record<string, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit card',
  loan: 'Loan',
  brokerage: 'Brokerage',
  retirement: 'Retirement',
  cash: 'Cash',
  property: 'Property',
  other: 'Other',
}
const typeItems = accountTypes.map((t) => ({ title: typeLabels[t] ?? t, value: t }))

const blank = () => ({
  name: '',
  type: 'checking' as string,
  institutionName: '',
  lastFour: '',
  includeInNetWorth: true,
  openingBalanceCents: null as number | null,
})
const form = ref(blank())

watch(open, (isOpen) => {
  if (!isOpen) return
  const a = props.account
  form.value = a
    ? {
        name: a.name,
        type: a.type,
        institutionName: a.institutionName ?? '',
        lastFour: a.lastFour ?? '',
        includeInNetWorth: a.includeInNetWorth,
        openingBalanceCents: null,
      }
    : blank()
  error.value = ''
})

async function save() {
  const f = form.value
  const done = await run(async () => {
    if (props.account) {
      await space.patch(`/accounts/${props.account.id}`, {
        name: f.name,
        type: f.type,
        institutionName: f.institutionName || null,
        lastFour: f.lastFour || null,
        includeInNetWorth: f.includeInNetWorth,
      })
    } else {
      await space.post('/accounts', {
        name: f.name,
        type: f.type,
        institutionName: f.institutionName || undefined,
        lastFour: f.lastFour || undefined,
        includeInNetWorth: f.includeInNetWorth,
        openingBalanceCents: f.openingBalanceCents ?? undefined,
      })
    }
    return true
  })
  if (done) {
    open.value = false
    emit('saved')
  }
}
</script>

<template>
  <FormDialog
    v-model="open"
    :title="account ? 'Edit account' : 'Add account'"
    :busy="busy"
    :error="error"
    @submit="save"
  >
    <v-text-field v-model="form.name" label="Account name" autofocus required />
    <v-select v-model="form.type" :items="typeItems" label="Type" />
    <v-text-field v-model="form.institutionName" label="Institution (optional)" />
    <v-text-field
      v-model="form.lastFour"
      label="Last four digits (optional)"
      maxlength="4"
      inputmode="numeric"
    />
    <MoneyInput
      v-if="!account"
      v-model="form.openingBalanceCents"
      label="Current balance (optional)"
    />
    <v-switch
      v-model="form.includeInNetWorth"
      label="Include in net worth"
      color="secondary"
      hide-details
    />
  </FormDialog>
</template>
