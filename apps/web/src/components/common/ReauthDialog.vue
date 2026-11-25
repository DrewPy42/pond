<script setup lang="ts">
import { ref, watch } from 'vue'
import { useReauthStore } from '../../stores/reauth'
import FormDialog from './FormDialog.vue'

/** Mounted once, in the app shell. Shown when something sensitive needs the password again. */
const reauth = useReauthStore()
const password = ref('')
// Never keep what was typed after the dialog closes.
watch(
  () => reauth.open,
  () => (password.value = ''),
)
</script>

<template>
  <FormDialog
    :model-value="reauth.open"
    title="Enter your password"
    submit-label="Continue"
    :busy="reauth.busy"
    :error="reauth.error"
    :submit-disabled="!password"
    :max-width="400"
    @update:model-value="!$event && reauth.cancel()"
    @submit="reauth.submit(password)"
  >
    <p class="mb-4 text-medium-emphasis">This is private, so Pond needs to check it's you.</p>
    <v-text-field
      v-model="password"
      label="Password"
      type="password"
      autocomplete="current-password"
      autofocus
    />
  </FormDialog>
</template>
