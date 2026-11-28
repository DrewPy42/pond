<script setup lang="ts">
import type { BackupSchedule, BackupView } from '@pond/shared'
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api'
import { useAction } from '../../composables/useAction'
import { useReauthRetry } from '../../composables/withReauth'
import { FormDialog } from '../common'
import RestoreSteps from './RestoreSteps.vue'
import { warningText, when } from './backupText'
import { backupWarnings } from './warnings'

const MIN_LENGTH = 12
const withReauth = useReauthRetry()
const { busy, error, run } = useAction()
const view = ref<BackupView | null>(null)
const done = ref('')
const restoreOpen = ref(false)

const passphraseOpen = ref(false)
const passphrase = ref('')
const again = ref('')

const folderEnabled = ref(false)
const keep = ref(14)
const schedule = ref<BackupSchedule>({
  enabled: false,
  frequency: 'daily',
  time: '02:00',
  weekday: 0,
})
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
  (title, value) => ({ title, value }),
)

function show(next: BackupView) {
  view.value = next
  backupWarnings.value = next.warnings
  folderEnabled.value = next.folder.enabled
  keep.value = next.keep
  schedule.value = { ...next.schedule }
}
async function load() {
  const r = await run(() => api<BackupView>('/api/backups'))
  if (r) show(r)
}
onMounted(load)

/**
 * The schedule and number of copies matter once the folder is on. They also show while a
 * schedule is on with nowhere to save, so that it can be turned off.
 */
const showSchedule = computed(() => folderEnabled.value || !!view.value?.schedule.enabled)

const changed = computed(
  () =>
    !!view.value &&
    (folderEnabled.value !== view.value.folder.enabled ||
      Number(keep.value) !== view.value.keep ||
      JSON.stringify(schedule.value) !== JSON.stringify(view.value.schedule)),
)

function openPassphrase() {
  passphrase.value = ''
  again.value = ''
  error.value = ''
  passphraseOpen.value = true
}
function closePassphrase() {
  passphraseOpen.value = false
  passphrase.value = ''
  again.value = ''
}
async function savePassphrase() {
  if (passphrase.value !== again.value) {
    error.value = "The two passphrases don't match."
    return
  }
  const r = await run(() =>
    withReauth(() =>
      api<BackupView>('/api/backups/passphrase', {
        method: 'PUT',
        body: { passphrase: passphrase.value },
      }),
    ),
  )
  if (r) {
    show(r)
    closePassphrase()
    done.value = 'Backup passphrase saved.'
  }
}

async function save(reconnect = false) {
  done.value = ''
  const put = (enabled: boolean, s: BackupSchedule) =>
    api<BackupView>('/api/backups/settings', {
      method: 'PUT',
      body: { folderEnabled: enabled, keep: Number(keep.value), schedule: s },
    })
  const wanted = { ...schedule.value, enabled: folderEnabled.value && schedule.value.enabled }
  const r = await run(() =>
    withReauth(async () => {
      // Turning the folder off and on again writes its marker afresh.
      if (reconnect) await put(false, { ...wanted, enabled: false })
      return put(folderEnabled.value, wanted)
    }),
  )
  if (r) {
    show(r)
    done.value = 'Saved.'
  } else await refreshAfterProblem()
}
async function refreshAfterProblem() {
  const message = error.value
  await load()
  error.value = message
}

async function backUp(destination: 'download' | 'folder') {
  done.value = ''
  const r = await run(() =>
    withReauth(() =>
      api<{ downloadId?: string; filename?: string }>('/api/backups/run', {
        method: 'POST',
        body: { destination },
      }),
    ),
  )
  if (r?.downloadId) {
    // The browser saves it straight to disk, so a large backup never sits in memory.
    const link = document.createElement('a')
    link.href = `/api/backups/download/${r.downloadId}`
    link.download = ''
    link.click()
    done.value = 'Your backup is made and checked. Your browser is saving it.'
  } else if (r?.filename) done.value = `Saved to the backup folder as ${r.filename}.`
  else return refreshAfterProblem()
  const message = done.value
  await load()
  done.value = message
}
</script>

<template>
  <h2 class="text-h6 mb-1">Backups</h2>
  <p class="text-body-2 text-medium-emphasis mb-3">
    A backup holds everything in Pond, encrypted with a passphrase only backups use.
  </p>
  <v-alert
    v-for="w in view?.warnings ?? []"
    :key="w.kind"
    type="warning"
    density="compact"
    class="mb-3"
  >
    {{ warningText(w) }}
  </v-alert>
  <v-alert v-if="error && !passphraseOpen" type="error" class="mb-3">{{ error }}</v-alert>
  <v-alert v-if="done" type="success" color="primary" density="compact" class="mb-3">{{
    done
  }}</v-alert>

  <template v-if="view">
    <v-card border flat class="mb-3">
      <v-card-title class="text-subtitle-1">Passphrase</v-card-title>
      <v-card-text>
        <p v-if="view.passphraseSet">
          Set. If you change it, older backups still need the old one.
        </p>
        <p v-else>Set a passphrase to start making backups.</p>
      </v-card-text>
      <v-card-actions>
        <v-btn
          :color="view.passphraseSet ? undefined : 'primary'"
          :variant="view.passphraseSet ? 'tonal' : 'flat'"
          @click="openPassphrase"
        >
          {{ view.passphraseSet ? 'Change passphrase' : 'Set passphrase' }}
        </v-btn>
      </v-card-actions>
    </v-card>

    <v-card border flat class="mb-3">
      <v-card-title class="text-subtitle-1">Back up now</v-card-title>
      <v-card-text>
        <div>Last saved to the folder: {{ when(view.lastFolderBackupAt) }}</div>
        <div>Last download: {{ when(view.lastDownloadAt) }}</div>
      </v-card-text>
      <v-card-actions class="flex-wrap">
        <v-btn
          :color="view.passphraseSet ? 'primary' : undefined"
          variant="flat"
          prepend-icon="mdi-download"
          :loading="busy"
          :disabled="!view.passphraseSet"
          @click="backUp('download')"
          >Download a backup</v-btn
        >
        <v-btn
          v-if="view.folder.enabled"
          variant="tonal"
          prepend-icon="mdi-harddisk"
          :disabled="busy || !view.passphraseSet"
          @click="backUp('folder')"
          >Back up to the folder</v-btn
        >
      </v-card-actions>
      <v-card-text class="pt-0 text-body-2">
        A backup kept at home won't survive a fire or theft. Download one now and then, and keep it
        somewhere else.
      </v-card-text>
    </v-card>

    <v-card border flat class="mb-3">
      <v-card-title class="text-subtitle-1">Backup folder and schedule</v-card-title>
      <v-card-text>
        <p v-if="!view.folder.available" class="mb-2">
          No backup folder is set up. To use a USB drive or network share, mount it at
          <code>/backups</code> in Pond's Docker settings.
        </p>
        <template v-else>
          <v-alert
            v-if="view.folder.enabled && !view.folder.connected"
            type="warning"
            density="compact"
            class="mb-3"
          >
            Pond's marker is missing from the folder, so it won't write there. Check that the drive
            or share is connected, then reconnect it.
            <div class="mt-2">
              <v-btn size="small" :loading="busy" @click="save(true)">Reconnect the folder</v-btn>
            </div>
          </v-alert>
        </template>
        <v-switch
          v-model="folderEnabled"
          color="secondary"
          label="Save backups to the backup folder"
          :disabled="!view.folder.available && !view.folder.enabled"
          hide-details
        />
        <template v-if="showSchedule">
          <v-switch
            v-model="schedule.enabled"
            color="secondary"
            label="Back up automatically"
            :disabled="!view.passphraseSet && !schedule.enabled"
            hide-details
          />
          <div v-if="schedule.enabled" class="d-flex ga-3 flex-wrap mt-2">
            <v-select
              v-model="schedule.frequency"
              label="How often"
              :items="[
                { title: 'Daily', value: 'daily' },
                { title: 'Weekly', value: 'weekly' },
              ]"
              density="compact"
              max-width="160"
              min-width="140"
              hide-details
            />
            <v-select
              v-if="schedule.frequency === 'weekly'"
              v-model="schedule.weekday"
              label="Day"
              :items="DAYS"
              density="compact"
              max-width="180"
              min-width="150"
              hide-details
            />
            <v-text-field
              v-model="schedule.time"
              label="Time"
              type="time"
              density="compact"
              max-width="150"
              min-width="130"
              hide-details
            />
          </div>
          <v-text-field
            v-model.number="keep"
            label="Copies to keep"
            type="number"
            min="1"
            max="365"
            density="compact"
            max-width="160"
            class="mt-3"
            hide-details
          />
        </template>
      </v-card-text>
      <v-card-actions>
        <v-btn
          :color="changed ? 'primary' : undefined"
          variant="flat"
          :disabled="!changed"
          :loading="busy"
          @click="save()"
          >Save</v-btn
        >
      </v-card-actions>
    </v-card>

    <v-card border flat>
      <v-card-title class="text-subtitle-1">Restore</v-card-title>
      <v-card-text>
        <p class="mb-3">Replace everything in Pond with what's in a backup.</p>
        <RestoreSteps v-if="restoreOpen" />
        <v-btn v-else variant="tonal" @click="restoreOpen = true">Restore from a backup</v-btn>
      </v-card-text>
    </v-card>
  </template>

  <FormDialog
    v-model="passphraseOpen"
    :title="view?.passphraseSet ? 'Change backup passphrase' : 'Set backup passphrase'"
    :busy="busy"
    :error="error"
    :submit-disabled="passphrase.length < MIN_LENGTH || !again"
    :max-width="480"
    @submit="savePassphrase"
    @update:model-value="!$event && closePassphrase()"
  >
    <v-alert type="warning" density="compact" class="mb-4">
      <strong>If you lose this passphrase, your backups can't be opened.</strong> Pond can't recover
      it. Keep it somewhere safe that isn't on this computer.
    </v-alert>
    <v-text-field
      v-model="passphrase"
      label="Passphrase"
      type="password"
      autocomplete="new-password"
      hint="At least 12 characters. A few unrelated words work well."
      persistent-hint
      class="mb-3"
    />
    <v-text-field
      v-model="again"
      label="Passphrase again"
      type="password"
      autocomplete="new-password"
    />
  </FormDialog>
</template>
