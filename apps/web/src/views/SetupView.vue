<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { errorMessage } from '../api'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const form = ref({ setupCode: '', username: '', displayName: '', password: '' })
const error = ref('')
const busy = ref(false)

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await auth.setup({ ...form.value })
    await router.replace('/security/enroll')
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <h1 class="text-h5 mb-1">Set up Pond</h1>
  <p class="text-medium-emphasis mb-4">
    Create the administrator account. The setup code was printed in the server console when Pond
    started.
  </p>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{
    error
  }}</v-alert>
  <v-form @submit.prevent="submit">
    <v-text-field v-model="form.setupCode" label="Setup code" autocomplete="off" required />
    <v-text-field v-model="form.displayName" label="Your name" autocomplete="name" required />
    <v-text-field v-model="form.username" label="Username" autocomplete="username" required />
    <v-text-field
      v-model="form.password"
      label="Password"
      type="password"
      autocomplete="new-password"
      hint="At least 12 characters"
      persistent-hint
      required
    />
    <v-btn type="submit" color="primary" block class="mt-6" :loading="busy">Create admin</v-btn>
  </v-form>
</template>
