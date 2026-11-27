<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { errorMessage } from '../api'
import RestoreSteps from '../components/backups/RestoreSteps.vue'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const form = ref({ username: '', displayName: '', password: '' })
const error = ref('')
const busy = ref(false)
const restoring = ref(false)

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
  <template v-if="restoring">
    <h1 class="text-h5 mb-1">Restore from a backup</h1>
    <p class="text-medium-emphasis mb-4">
      Bring back everything from a Pond backup file. Afterwards you sign in with the accounts and
      authenticator you had when it was made.
    </p>
    <RestoreSteps first-run />
    <v-btn variant="text" block class="mt-4" @click="restoring = false">
      Set up a new Pond instead
    </v-btn>
  </template>
  <template v-else>
    <h1 class="text-h5 mb-1">Set up Pond</h1>
    <p class="text-medium-emphasis mb-4">Create the administrator account.</p>
    <v-alert type="warning" density="compact" class="mb-4">
      If you've used this Pond before, stop here. It can't find your data.
    </v-alert>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{
      error
    }}</v-alert>
    <v-form @submit.prevent="submit">
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
    <v-btn variant="text" block class="mt-3" @click="restoring = true">
      Restore from a backup
    </v-btn>
  </template>
</template>
