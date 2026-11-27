<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError, errorMessage } from '../api'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const username = ref('')
const password = ref('')
const code = ref('')
const needsCode = ref(false)
const error = ref('')
const busy = ref(false)
const showPassword = ref(false)

// The code belongs to the name and password it was asked for. Change either and sign-in starts
// over, so nothing is left locked and the new ones are checked first.
watch([username, password], () => {
  if (!needsCode.value) return
  needsCode.value = false
  code.value = ''
  error.value = ''
})

/**
 * Pond asks for a code only after accepting the name and password, so a refusal at that step is
 * about the code.
 */
function explain(e: unknown): string {
  if (!(e instanceof ApiError) || e.code !== 'invalid_credentials') return errorMessage(e)
  if (!needsCode.value) return 'Wrong username or password.'
  return "That code didn't work. Use the newest code from your authenticator's entry for this Pond, or an unused recovery code."
}

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await auth.login(username.value, password.value, needsCode.value ? code.value : undefined)
    const next =
      typeof route.query.next === 'string' && route.query.next.startsWith('/')
        ? route.query.next
        : '/'
    await router.replace(auth.enrollmentRequired ? '/security/enroll' : next)
  } catch (e) {
    if (e instanceof ApiError && e.code === 'totp_required') needsCode.value = true
    else {
      error.value = explain(e)
      code.value = ''
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <h1 class="text-h5 mb-4">Sign in</h1>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{
    error
  }}</v-alert>
  <v-form @submit.prevent="submit">
    <v-text-field v-model="username" label="Username" autocomplete="username" />
    <v-text-field
      v-model="password"
      label="Password"
      :type="showPassword ? 'text' : 'password'"
      autocomplete="current-password"
      autocapitalize="off"
      spellcheck="false"
    >
      <template #append-inner>
        <v-btn
          :icon="showPassword ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
          :aria-label="showPassword ? 'Hide password' : 'Show password'"
          :aria-pressed="showPassword"
          variant="text"
          size="small"
          density="comfortable"
          @click="showPassword = !showPassword"
        />
      </template>
    </v-text-field>
    <v-text-field
      v-if="needsCode"
      v-model="code"
      label="Authenticator code or recovery code"
      autocomplete="one-time-code"
      autofocus
    />
    <v-btn type="submit" color="primary" block class="mt-4" :loading="busy">
      {{ needsCode ? 'Verify' : 'Sign in' }}
    </v-btn>
  </v-form>
</template>
