<script setup lang="ts">
import { ref } from 'vue'
import { ApiError, api } from '../../api'
import { useAction } from '../../composables/useAction'
import { FormDialog } from '../common'

/** Changing your own password, for example the temporary one an administrator gave you. */
const open = ref(false)
const done = ref(false)
const { busy, error, run } = useAction()
const current = ref('')
const next = ref('')
const again = ref('')

function clear() {
  current.value = ''
  next.value = ''
  again.value = ''
}
function start() {
  clear()
  error.value = ''
  done.value = false
  open.value = true
}
async function save() {
  if (next.value !== again.value) {
    error.value = "The two new passwords don't match."
    return
  }
  let wrongCurrent = false
  const ok = await run(async () => {
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: current.value, newPassword: next.value },
      })
    } catch (e) {
      wrongCurrent = e instanceof ApiError && e.code === 'invalid_credentials'
      throw e
    }
    return true
  })
  if (wrongCurrent) error.value = "Your current password isn't right."
  if (ok) {
    clear()
    open.value = false
    done.value = true
  }
}
</script>

<template>
  <h2 class="text-h6 mb-2">Your password</h2>
  <v-alert v-if="done" type="success" variant="tonal" density="compact" class="mb-3"
    >Password changed. Your other sign-ins have been ended.</v-alert
  >
  <v-btn variant="tonal" @click="start">Change password</v-btn>
  <FormDialog
    v-model="open"
    title="Change password"
    submit-label="Change"
    :busy="busy"
    :error="error"
    :submit-disabled="!current || !next || !again"
    :max-width="440"
    @submit="save"
    @update:model-value="!$event && clear()"
  >
    <v-text-field
      v-model="current"
      label="Current password"
      type="password"
      autocomplete="current-password"
    />
    <v-text-field
      v-model="next"
      label="New password"
      type="password"
      autocomplete="new-password"
      hint="At least 12 characters"
      persistent-hint
      class="mb-3"
    />
    <v-text-field
      v-model="again"
      label="New password again"
      type="password"
      autocomplete="new-password"
    />
  </FormDialog>
</template>
