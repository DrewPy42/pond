<script setup lang="ts">
import { ref } from 'vue'
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
    else error.value = errorMessage(e)
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
    <v-text-field
      v-model="username"
      label="Username"
      autocomplete="username"
      :disabled="needsCode"
    />
    <v-text-field
      v-model="password"
      label="Password"
      type="password"
      autocomplete="current-password"
      :disabled="needsCode"
    />
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
