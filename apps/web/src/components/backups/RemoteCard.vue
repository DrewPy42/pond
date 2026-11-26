<script setup lang="ts">
import type { BackupView } from '@pond/shared'
import { computed, ref } from 'vue'
import { api } from '../../api'
import { useAction } from '../../composables/useAction'
import { useReauthRetry } from '../../composables/withReauth'
import { FormDialog } from '../common'
import { when } from './backupText'

/** Backups to online storage, through rclone. The pasted setup is only ever sent, never shown. */
const props = defineProps<{ view: BackupView }>()
const emit = defineEmits<{ updated: [view: BackupView] }>()

const withReauth = useReauthRetry()
const { busy, error, run } = useAction()
const done = ref('')
const editing = ref(false)
const removing = ref(false)
const setup = ref('')
const folder = ref('')
const remote = computed(() => props.view.remote)

function openForm() {
  setup.value = ''
  folder.value = remote.value.folder ?? 'Pond backups'
  error.value = ''
  done.value = ''
  editing.value = true
}
function closeForm() {
  editing.value = false
  setup.value = '' // it holds sign-in tokens
}
function closeDialogs() {
  closeForm()
  removing.value = false
}

/** Sends a change and shows the result. */
async function change(method: 'PUT' | 'DELETE', body: object | undefined, message: string) {
  done.value = ''
  const next = await run(() =>
    withReauth(() => api<BackupView>('/api/backups/remote', { method, body })),
  )
  if (!next) return
  closeDialogs()
  done.value = message
  emit('updated', next)
}

const save = () =>
  change(
    'PUT',
    {
      ...(setup.value.trim() ? { setup: setup.value } : {}),
      folder: folder.value,
      enabled: true,
    },
    'Saved. Pond could open the folder.',
  )
const setEnabled = (enabled: boolean) =>
  change(
    'PUT',
    { folder: remote.value.folder, enabled },
    enabled ? 'Online storage is on.' : 'Online storage is off.',
  )
const remove = () => change('DELETE', undefined, 'Online storage was removed.')

async function backUp() {
  done.value = ''
  const r = await run(() =>
    withReauth(() =>
      api<{ filename: string }>('/api/backups/run', {
        method: 'POST',
        body: { destination: 'remote' },
      }),
    ),
  )
  if (!r) return
  const next = await run(() => api<BackupView>('/api/backups'))
  if (next) emit('updated', next)
  done.value = `Uploaded as ${r.filename}.`
}
</script>

<template>
  <v-card border flat class="mb-3">
    <v-card-title class="text-subtitle-1">Online storage</v-card-title>
    <v-card-text>
      <v-alert v-if="error && !editing && !removing" type="error" density="compact" class="mb-3">{{
        error
      }}</v-alert>
      <v-alert v-if="done" type="success" color="primary" density="compact" class="mb-3">{{
        done
      }}</v-alert>
      <p v-if="!remote.available" class="mb-2">
        This Pond doesn't have rclone, so it can't send backups to online storage.
      </p>
      <p v-if="!remote.configured">
        Keep a copy away from home in Google Drive, Dropbox, Box, OneDrive, Backblaze B2 or
        S3-compatible storage.
      </p>
      <template v-else>
        <div>
          <strong>{{ remote.service }}</strong>, folder “{{ remote.folder }}” ·
          {{ remote.enabled ? (remote.paused ? 'Paused' : 'On') : 'Off' }}
        </div>
        <div>Last upload: {{ when(view.lastRemoteBackupAt) }}</div>
        <v-alert v-if="remote.enabled && remote.paused" type="warning" class="mt-3">
          Paused since a restore, so nothing is uploaded or deleted. Turn it back on only if this is
          now your one Pond using this folder: another copy would delete its old backups. If the
          sign-in fails, paste a new setup.
          <div class="mt-2">
            <v-btn size="small" variant="outlined" :loading="busy" @click="setEnabled(true)">
              Turn back on
            </v-btn>
          </div>
        </v-alert>
      </template>
    </v-card-text>
    <v-card-actions class="flex-wrap">
      <v-btn
        v-if="!remote.configured"
        :color="remote.available ? 'primary' : undefined"
        variant="tonal"
        :disabled="!remote.available"
        @click="openForm"
        >Set up online storage</v-btn
      >
      <template v-else>
        <v-btn
          v-if="remote.enabled && !remote.paused"
          variant="tonal"
          prepend-icon="mdi-cloud-upload-outline"
          :loading="busy"
          :disabled="!view.passphraseSet || !remote.available"
          @click="backUp"
          >Back up to online storage</v-btn
        >
        <v-btn variant="text" :disabled="busy || !remote.available" @click="openForm">Change</v-btn>
        <v-btn
          v-if="!remote.enabled"
          variant="text"
          :disabled="busy || !remote.available"
          @click="setEnabled(true)"
          >Turn on</v-btn
        >
        <v-btn v-else variant="text" :disabled="busy" @click="setEnabled(false)">Turn off</v-btn>
        <v-btn variant="text" :disabled="busy" @click="removing = true">Remove</v-btn>
      </template>
    </v-card-actions>
  </v-card>

  <FormDialog
    :model-value="editing"
    :title="remote.configured ? 'Change online storage' : 'Set up online storage'"
    submit-label="Save and check"
    :busy="busy"
    :error="error"
    :submit-disabled="!folder.trim() || (!remote.configured && !setup.trim())"
    :max-width="640"
    @update:model-value="!$event && closeForm()"
    @submit="save"
  >
    <p class="mb-2">
      Pond has its own copy of rclone for uploading, but it can't open a web browser to sign in to
      your storage. So you set that up once on your own computer, then give Pond the result.
    </p>
    <p class="mb-1">On a computer with a web browser (your everyday one is fine):</p>
    <ol class="pl-5 mb-3">
      <li>Install rclone from rclone.org.</li>
      <li>Run <code>rclone config</code> and add your storage. Give it any name.</li>
      <li>Run <code>rclone config show NAME</code>, using that name.</li>
    </ol>
    <p class="mb-3">Then paste everything it prints below.</p>
    <v-textarea
      v-model="setup"
      :label="remote.configured ? 'New setup (leave empty to keep the current one)' : 'Setup'"
      rows="7"
      autocomplete="off"
      spellcheck="false"
      persistent-hint
      hint="It lets whoever has it into your storage. Pond keeps it encrypted and never shows it again."
      class="mb-3 setup-text"
    />
    <v-text-field
      v-model="folder"
      label="Folder"
      persistent-hint
      hint="For S3 and Backblaze B2, start with the bucket's name."
    />
  </FormDialog>

  <FormDialog
    v-model="removing"
    title="Remove online storage"
    submit-label="Remove"
    :busy="busy"
    :error="error"
    :max-width="440"
    @submit="remove"
  >
    <p>Pond forgets the setup and stops uploading. Backups already in your storage stay there.</p>
  </FormDialog>
</template>

<style scoped>
.setup-text :deep(textarea) {
  font-family: monospace;
  font-size: 0.8rem;
}
</style>
