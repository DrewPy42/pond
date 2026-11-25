<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../../api'
import { roleLabel } from '../../composables/spaces'
import { useAction } from '../../composables/useAction'
import { useAuthStore } from '../../stores/auth'
import { useSpacesStore, type SpaceSummary } from '../../stores/spaces'
import { FormDialog } from '../common'
import MembersDialog from './MembersDialog.vue'
import NewSpaceDialog from './NewSpaceDialog.vue'

/** Every Space you can see. Owners rename them and choose who's in them. */
const auth = useAuthStore()
const spaces = useSpacesStore()
const { busy, error, run } = useAction()
const creating = ref(false)
const membersOf = ref<SpaceSummary | null>(null)
const membersOpen = ref(false)
const renaming = ref<SpaceSummary | null>(null)
const renameOpen = ref(false)
const newName = ref('')

// ----- archive, restore, delete (administrator) -----
const archived = ref<SpaceSummary[]>([])
type Removal = 'archive' | 'restore' | 'delete'
const pending = ref<{ space: SpaceSummary; action: Removal } | null>(null)
const removal = useAction()
const WORDS: Record<Removal, { title: (n: string) => string; text: string; button: string }> = {
  archive: {
    title: (n) => `Archive ${n}?`,
    text: 'It disappears from Pond for everyone, and its bank syncing and apps stop. Nothing is deleted, and you can restore it later. Parts of other transactions that were put in it can’t be changed while it is archived.',
    button: 'Archive',
  },
  restore: {
    title: (n) => `Restore ${n}?`,
    text: 'It comes back with the same people and apps. Bank syncing looks back up to 90 days for what happened while it was away.',
    button: 'Restore',
  },
  delete: {
    title: (n) => `Delete ${n} for good?`,
    text: 'Only an empty Space can be deleted: one with no accounts, transactions or app records. This can’t be undone.',
    button: 'Delete',
  },
}

async function loadArchived() {
  if (!auth.user?.isAdmin) return
  archived.value = await api<{ spaces: SpaceSummary[] }>('/api/spaces/archived')
    .then((r) => r.spaces)
    .catch(() => [])
}
onMounted(loadArchived)

function ask(space: SpaceSummary, action: Removal) {
  removal.error.value = ''
  pending.value = { space, action }
}
async function confirm() {
  const p = pending.value
  if (!p) return
  const done = await removal.run(async () => {
    if (p.action === 'delete') await api(`/api/spaces/${p.space.id}`, { method: 'DELETE' })
    else await api(`/api/spaces/${p.space.id}/${p.action}`, { method: 'POST', body: {} })
    return true
  })
  // On a refusal the dialog stays, saying why.
  if (!done) return
  pending.value = null
  await loadArchived()
  await spaces.load()
}

function openMembers(s: SpaceSummary) {
  membersOf.value = s
  membersOpen.value = true
}
function openRename(s: SpaceSummary) {
  renaming.value = s
  newName.value = s.name
  error.value = ''
  renameOpen.value = true
}
async function rename() {
  const s = renaming.value
  if (!s || !newName.value.trim()) return
  const done = await run(
    async () => (
      await api(`/api/spaces/${s.id}`, { method: 'PATCH', body: { name: newName.value } }),
      true
    ),
  )
  if (done) {
    renameOpen.value = false
    await spaces.load()
  }
}
</script>

<template>
  <div class="d-flex align-center mb-1 ga-3 flex-wrap">
    <h2 class="text-h6">Spaces</h2>
    <v-spacer />
    <v-btn
      v-if="auth.user?.isAdmin"
      color="primary"
      prepend-icon="mdi-plus"
      @click="creating = true"
      >New Space</v-btn
    >
  </div>
  <p class="text-body-2 text-medium-emphasis mb-3">
    A Space keeps one set of money apart from another, such as your household and a business.
  </p>
  <p v-if="spaces.spaces.length === 0" class="text-medium-emphasis">
    {{
      auth.user?.isAdmin
        ? 'No Spaces yet. Create your first one to get started.'
        : "You aren't in a Space yet. Ask your administrator to add you to one."
    }}
  </p>
  <v-card v-for="s in spaces.spaces" :key="s.id" border flat class="mb-2">
    <v-card-text class="d-flex align-center ga-3 flex-wrap">
      <div style="flex: 1; min-width: 200px">
        <div class="text-subtitle-1">{{ s.name }}</div>
        <div class="text-caption text-medium-emphasis">
          {{ s.type === 'business' ? 'Business' : 'Personal' }} ·
          {{ auth.user?.isAdmin ? 'You are the administrator' : `Your role: ${roleLabel(s.role)}` }}
        </div>
      </div>
      <template v-if="s.role === 'owner'">
        <v-btn variant="text" size="small" :aria-label="`Rename ${s.name}`" @click="openRename(s)"
          >Rename</v-btn
        >
        <v-btn
          variant="tonal"
          size="small"
          prepend-icon="mdi-account-multiple-outline"
          :aria-label="`Who is in ${s.name}`"
          @click="openMembers(s)"
          >Who's in it</v-btn
        >
      </template>
      <v-menu v-if="auth.user?.isAdmin">
        <template #activator="{ props: menuProps }">
          <v-btn
            v-bind="menuProps"
            icon="mdi-dots-vertical"
            size="small"
            variant="text"
            :aria-label="`More options for ${s.name}`"
          />
        </template>
        <v-list density="compact">
          <v-list-item title="Archive" @click="ask(s, 'archive')" />
          <v-list-item title="Delete" @click="ask(s, 'delete')" />
        </v-list>
      </v-menu>
    </v-card-text>
  </v-card>

  <template v-if="archived.length">
    <h3 class="text-subtitle-1 mt-4 mb-2">Archived Spaces</h3>
    <v-card v-for="s in archived" :key="s.id" border flat class="mb-2">
      <v-card-text class="d-flex align-center ga-3 flex-wrap">
        <div style="flex: 1; min-width: 200px" class="text-medium-emphasis">{{ s.name }}</div>
        <v-btn
          variant="tonal"
          size="small"
          :aria-label="`Restore ${s.name}`"
          @click="ask(s, 'restore')"
          >Restore</v-btn
        >
        <v-btn
          variant="text"
          size="small"
          :aria-label="`Delete ${s.name}`"
          @click="ask(s, 'delete')"
          >Delete</v-btn
        >
      </v-card-text>
    </v-card>
  </template>

  <v-dialog :model-value="!!pending" max-width="460" @update:model-value="pending = null">
    <v-card v-if="pending" :title="WORDS[pending.action].title(pending.space.name)">
      <v-card-text>
        <v-alert
          v-if="removal.error.value"
          type="error"
          variant="tonal"
          density="compact"
          class="mb-3"
          >{{ removal.error.value }}</v-alert
        >
        {{ WORDS[pending.action].text }}
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="pending = null">Cancel</v-btn>
        <v-btn
          :color="pending.action === 'delete' ? 'error' : 'primary'"
          :loading="removal.busy.value"
          @click="confirm"
          >{{ WORDS[pending.action].button }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>

  <NewSpaceDialog v-model="creating" />
  <MembersDialog v-model="membersOpen" :space="membersOf" />
  <FormDialog
    v-model="renameOpen"
    title="Rename Space"
    :busy="busy"
    :error="error"
    :submit-disabled="!newName.trim()"
    :max-width="420"
    @submit="rename"
  >
    <v-text-field v-model="newName" label="Name" maxlength="80" autofocus />
  </FormDialog>
</template>
