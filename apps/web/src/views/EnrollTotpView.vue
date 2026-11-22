<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorMessage } from '../api'
import { QrCode } from '../components/common'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const secret = ref('')
const uri = ref('')
const code = ref('')
const recovery = ref<string[] | null>(null)
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  try {
    const r = await api<{ secret: string; uri: string }>('/api/auth/totp/enroll', {
      method: 'POST',
      body: {},
    })
    secret.value = r.secret
    uri.value = r.uri
  } catch (e) {
    error.value = errorMessage(e)
  }
})

async function confirm() {
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ recoveryCodes: string[] }>('/api/auth/totp/confirm', {
      method: 'POST',
      body: { code: code.value },
    })
    recovery.value = r.recoveryCodes
    auth.markTotpEnabled()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <template v-if="!recovery">
    <h1 class="text-h5 mb-1">Turn on two-step sign-in</h1>
    <p class="text-medium-emphasis mb-4">
      Scan this QR code with an authenticator app (1Password, Authy, Google Authenticator, ...),
      then enter the 6-digit code it shows. Administrators must do this.
    </p>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{
      error
    }}</v-alert>
    <div v-if="uri" class="d-flex justify-center mb-4">
      <QrCode :value="uri" :size="200" label="QR code for your authenticator app" />
    </div>
    <p class="text-body-2 text-medium-emphasis mb-2">Can't scan? Enter this key instead:</p>
    <v-text-field :model-value="secret" label="Secret key" readonly data-testid="totp-secret" />
    <p class="mb-4"><a :href="uri">Open in authenticator app</a></p>
    <v-form @submit.prevent="confirm">
      <v-text-field
        v-model="code"
        label="6-digit code"
        inputmode="numeric"
        autocomplete="one-time-code"
      />
      <v-btn type="submit" color="primary" block :loading="busy">Confirm</v-btn>
    </v-form>
  </template>
  <template v-else>
    <h1 class="text-h5 mb-1">Save your recovery codes</h1>
    <v-alert type="warning" variant="tonal" density="compact" class="mb-4">
      Each code works once if you lose your authenticator. They are shown only now.
    </v-alert>
    <v-sheet border rounded class="pa-4 mb-4 font-mono" data-testid="recovery-codes">
      <div v-for="c in recovery" :key="c">{{ c }}</div>
    </v-sheet>
    <v-btn color="primary" block @click="router.replace('/')">I saved them</v-btn>
  </template>
</template>

<style scoped>
.font-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
