<script setup lang="ts">
import type { RestoreSummary } from '@pond/shared'
import { onBeforeUnmount, ref } from 'vue'
import { api, apiUpload } from '../../api'
import { useAction } from '../../composables/useAction'
import { useReauthRetry } from '../../composables/withReauth'
import { when } from './backupText'

/** Upload, check, confirm. Used in Settings and on a brand-new install's first screen. */
const props = withDefaults(defineProps<{ firstRun?: boolean; pollMs?: number }>(), {
  firstRun: false,
  pollMs: 2000,
})

const withReauth = useReauthRetry()
const { busy, error, run } = useAction()
const file = ref<File | null>(null)
const passphrase = ref('')
const uploadId = ref('')
const summary = ref<RestoreSummary | null>(null)
const agreed = ref(false)
const restarting = ref(false)
const slow = ref(false)

const base = () => (props.firstRun ? '/api/setup/restore' : '/api/backups/restore')
const post = <T,>(step: string, body: object) =>
  api<T>(`${base()}/${step}`, { method: 'POST', body })

function chooseAgain() {
  uploadId.value = ''
  summary.value = null
  agreed.value = false
}

async function check() {
  const chosen = file.value
  if (!chosen) return
  const result = await run(() =>
    withReauth(async () => {
      // A wrong passphrase doesn't mean uploading the file again.
      uploadId.value ||= (
        await apiUpload<{ uploadId: string }>(`${base()}/upload`, chosen)
      ).uploadId
      return post<{ summary: RestoreSummary }>('check', {
        uploadId: uploadId.value,
        passphrase: passphrase.value,
      })
    }),
  )
  if (result) {
    summary.value = result.summary
    passphrase.value = ''
  }
}

async function confirm() {
  const ok = await run(() =>
    withReauth(() => post('confirm', { uploadId: uploadId.value, replaceEverything: true })),
  )
  if (!ok) return
  restarting.value = true
  waitForRestart()
}

let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false
onBeforeUnmount(() => {
  stopped = true
  clearTimeout(timer)
})

/** The restore has been applied once the old sign-in (or the empty install) is gone. */
async function restored(): Promise<boolean> {
  try {
    if (props.firstRun)
      return !(await api<{ setupRequired: boolean }>('/api/setup/status')).setupRequired
    await api('/api/auth/me')
    return false
  } catch (e) {
    return (e as { status?: number }).status === 401
  }
}
function waitForRestart(tries = 0) {
  timer = setTimeout(async () => {
    if (await restored()) return window.location.assign('/login')
    if (tries >= 20) slow.value = true
    if (!stopped) waitForRestart(tries + 1)
  }, props.pollMs)
}
</script>

<template>
  <v-alert v-if="restarting" type="info" color="secondary">
    <strong>Pond is restarting to finish the restore.</strong>
    <p class="mt-1">This page will take you to sign in when it's ready.</p>
    <p v-if="slow" class="mt-2">
      It's taking a while. If Pond doesn't restart by itself, start it again. The restore happens as
      it starts.
    </p>
  </v-alert>

  <v-form v-else-if="!summary" @submit.prevent="check">
    <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>
    <v-file-input
      v-model="file"
      label="Backup file"
      accept=".pond"
      @update:model-value="chooseAgain"
    />
    <v-text-field
      v-model="passphrase"
      label="Backup passphrase"
      type="password"
      autocomplete="off"
    />
    <v-btn type="submit" color="primary" :loading="busy" :disabled="!file || !passphrase"
      >Check this backup</v-btn
    >
    <p v-if="busy" class="text-caption mt-2">
      Uploading and checking. A large backup can take a few minutes.
    </p>
  </v-form>

  <div v-else>
    <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>
    <p class="mb-1">
      <strong>Backup from {{ when(summary.createdAt) }}</strong>
    </p>
    <p class="mb-3">
      Users: {{ summary.counts.users }} · Spaces: {{ summary.counts.spaces }} · Accounts:
      {{ summary.counts.accounts }} · Transactions: {{ summary.counts.transactions }} · Files:
      {{ summary.counts.files }}
    </p>
    <v-alert v-for="w in summary.warnings" :key="w" type="warning" density="compact" class="mb-3">{{
      w
    }}</v-alert>
    <v-alert type="error" class="mb-2">
      <strong>Everything now in Pond will be replaced</strong> by this backup. Anything added since
      it was made will be gone, and everyone will be signed out.
      <span v-if="!firstRun">Pond keeps a safety copy of what it has now on this computer.</span>
    </v-alert>
    <v-checkbox v-model="agreed" label="Replace everything with this backup" hide-details />
    <div class="d-flex ga-3 flex-wrap mt-2">
      <v-btn color="error" :disabled="!agreed" :loading="busy" @click="confirm">Restore</v-btn>
      <v-btn variant="text" :disabled="busy" @click="chooseAgain">Cancel</v-btn>
    </div>
  </div>
</template>
