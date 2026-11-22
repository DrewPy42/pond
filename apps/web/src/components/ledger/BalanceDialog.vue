<script setup lang="ts">
import type { AccountView } from '@pond/shared'
import { ref, watch } from 'vue'
import { FormDialog, MoneyInput } from '../common'
import { useAction } from '../../composables/useAction'
import { useSpaceApi } from '../../composables/useSpaceApi'

/** Record what a manual account's balance is on a given day (one per day; entering again replaces it). */
const props = defineProps<{ account: AccountView | null }>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ saved: [] }>()

const space = useSpaceApi()
const { busy, error, run } = useAction()
const today = () => new Date().toISOString().slice(0, 10)
const date = ref(today())
const cents = ref<number | null>(null)

watch(open, (isOpen) => {
  if (!isOpen) return
  date.value = today()
  cents.value = props.account?.balanceCents ?? null
  error.value = ''
})

async function save() {
  if (!props.account || cents.value === null) return
  const done = await run(async () => {
    await space.put(`/accounts/${props.account!.id}/balances/${date.value}`, {
      balanceCents: cents.value,
    })
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
    :title="`Record balance: ${account?.name ?? ''}`"
    submit-label="Record"
    :busy="busy"
    :error="error"
    :submit-disabled="cents === null"
    :max-width="440"
    @submit="save"
  >
    <v-text-field v-model="date" label="Date" type="date" />
    <MoneyInput v-model="cents" label="Balance" />
    <p class="text-caption text-medium-emphasis">
      Money you owe (a credit card, a loan) is a negative balance.
    </p>
  </FormDialog>
</template>
