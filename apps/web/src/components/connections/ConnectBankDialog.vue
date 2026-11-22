<script setup lang="ts">
import type { ConnectionView } from '@pond/shared'
import { ref, watch } from 'vue'
import { api } from '../../api'
import { FormDialog } from '../common'
import { useAction } from '../../composables/useAction'

/**
 * Paste a SimpleFIN Setup Token to connect a bank. The token is single-use: the server exchanges
 * it once, stores the resulting access encrypted, and we clear it from this form right away.
 */
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ connected: [connection: ConnectionView] }>()

const { busy, error, run } = useAction()
const token = ref('')
const label = ref('')

watch(open, (isOpen) => {
  if (!isOpen) return
  token.value = ''
  label.value = ''
  error.value = ''
})

async function connect() {
  const r = await run(() =>
    api<{ connection: ConnectionView }>('/api/connections', {
      method: 'POST',
      body: { setupToken: token.value.trim(), label: label.value.trim() },
    }),
  )
  token.value = '' // never keep it around
  if (r) {
    open.value = false
    emit('connected', r.connection)
  }
}
</script>

<template>
  <FormDialog
    v-model="open"
    title="Connect a bank"
    submit-label="Connect"
    :busy="busy"
    :error="error"
    :submit-disabled="token.trim().length < 8 || !label.trim()"
    @submit="connect"
  >
    <p class="text-body-2 mb-4">
      Pond reads your accounts through your own
      <a
        href="https://bridge.simplefin.org/simplefin/create"
        target="_blank"
        rel="noopener noreferrer"
        >SimpleFIN Bridge</a
      >
      account (read-only; it can't move money). Create a Setup Token there and paste it below. A
      token works once.
    </p>
    <v-text-field
      v-model="label"
      label="Name for this connection"
      hint="For example: Chase and Ally"
      persistent-hint
      autofocus
    />
    <v-textarea
      v-model="token"
      label="SimpleFIN Setup Token"
      rows="3"
      auto-grow
      autocomplete="off"
      spellcheck="false"
      class="mt-2"
    />
  </FormDialog>
</template>
