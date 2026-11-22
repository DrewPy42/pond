<script setup lang="ts">
import type { FullTransactionView, TransactionView } from '@pond/shared'
import { ref, watch } from 'vue'
import { FormDialog, MoneyAmount } from '../common'
import { useAction } from '../../composables/useAction'
import { useSpaceApi } from '../../composables/useSpaceApi'

/**
 * Pick the other half of a transfer: a transaction of equal and opposite amount, on another
 * account, within two weeks. The server re-checks every rule when linking.
 */
const props = defineProps<{ transaction: FullTransactionView }>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ linked: [] }>()

const space = useSpaceApi()
const { busy, error, run } = useAction()
const candidates = ref<FullTransactionView[]>([])
const chosen = ref<string | null>(null)
const loaded = ref(false)

const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

watch(open, async (isOpen) => {
  if (!isOpen) return
  loaded.value = false
  chosen.value = null
  const t = props.transaction
  const res = await run(() =>
    space.get<{ transactions: TransactionView[] }>(
      `/transactions?from=${shift(t.date, -14)}&to=${shift(t.date, 14)}&limit=200`,
    ),
  )
  candidates.value = (res?.transactions ?? []).filter(
    (x): x is FullTransactionView =>
      x.kind === 'full' &&
      x.id !== t.id &&
      x.accountId !== t.accountId &&
      x.amountCents === -t.amountCents,
  )
  loaded.value = true
})

async function link() {
  if (!chosen.value) return
  const done = await run(async () => {
    await space.post('/transfers', {
      transactionId: props.transaction.id,
      otherTransactionId: chosen.value,
    })
    return true
  })
  if (done) {
    open.value = false
    emit('linked')
  }
}
</script>

<template>
  <FormDialog
    v-model="open"
    title="Link as transfer"
    submit-label="Link"
    :busy="busy"
    :error="error"
    :submit-disabled="!chosen"
    :max-width="520"
    @submit="link"
  >
    <p class="mb-3 text-body-2">
      Find the matching
      <MoneyAmount :cents="-transaction.amountCents" /> on a different account.
    </p>
    <v-radio-group v-model="chosen" hide-details>
      <v-radio v-for="c in candidates" :key="c.id" :value="c.id">
        <template #label>
          <span class="d-flex ga-3 align-center flex-wrap">
            <span>{{ c.date }}</span>
            <span>{{ c.accountName }}</span>
            <span class="text-medium-emphasis">{{ c.descriptionRaw }}</span>
          </span>
        </template>
      </v-radio>
    </v-radio-group>
    <p v-if="loaded && candidates.length === 0" class="text-medium-emphasis">
      No matching transaction found within two weeks. Add the other side first, then link them.
    </p>
  </FormDialog>
</template>
