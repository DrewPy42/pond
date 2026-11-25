<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '../../api'
import {
  ROLE_ITEMS,
  addableUsers,
  isLastOwner,
  type ManagedUser,
  type Member,
  type SpaceRole,
} from '../../composables/spaces'
import { useAction } from '../../composables/useAction'
import { useAuthStore } from '../../stores/auth'
import { useSpacesStore, type SpaceSummary } from '../../stores/spaces'

/** Who is in a Space and what they can do (Space owners and the administrator). */
const props = defineProps<{ space: SpaceSummary | null }>()
const open = defineModel<boolean>({ required: true })
const withSubtitle = (i: { subtitle: string }) => ({ subtitle: i.subtitle })
const auth = useAuthStore()
const spaces = useSpacesStore()
const { busy, error, run } = useAction()
const members = ref<Member[]>([])
const users = ref<ManagedUser[]>([])
const pickedUser = ref<string | null>(null)
const username = ref('')
const role = ref<SpaceRole>('viewer')
const removing = ref<Member | null>(null)

const isAdmin = computed(() => !!auth.user?.isAdmin)
const choices = computed(() =>
  addableUsers(users.value, members.value).map((u) => ({
    value: u.id,
    title: `${u.displayName} (${u.username})`,
  })),
)
const base = () => `/api/spaces/${props.space!.id}/members`

async function loadMembers() {
  const r = await run(() => api<{ members: Member[] }>(base()))
  if (r) members.value = r.members
}
watch(open, async (isOpen) => {
  if (!isOpen || !props.space) return
  members.value = []
  pickedUser.value = null
  username.value = ''
  role.value = 'viewer'
  await loadMembers()
  // Only the administrator can see the list of users.
  if (isAdmin.value) {
    users.value = await api<{ users: ManagedUser[] }>('/api/users')
      .then((r) => r.users)
      .catch(() => [])
  }
})

/** Runs a change, then shows what the server actually holds, keeping any error on screen. */
async function change(action: () => Promise<unknown>): Promise<boolean> {
  const done = await run(async () => (await action(), true))
  const problem = error.value
  await loadMembers()
  error.value = problem
  return !!done
}

async function add() {
  const done = await change(() =>
    isAdmin.value
      ? api(`${base()}/${pickedUser.value}`, { method: 'PUT', body: { role: role.value } })
      : api(base(), { method: 'POST', body: { username: username.value, role: role.value } }),
  )
  if (done) {
    pickedUser.value = null
    username.value = ''
  }
}
const setRole = (m: Member, next: SpaceRole) =>
  change(() => api(`${base()}/${m.userId}`, { method: 'PUT', body: { role: next } })).then(() =>
    m.userId === auth.user?.id ? spaces.load() : undefined,
  )

async function remove() {
  const m = removing.value
  if (!m) return
  removing.value = null
  const done = await run(
    async () => (await api(`${base()}/${m.userId}`, { method: 'DELETE' }), true),
  )
  if (done && m.userId === auth.user?.id && !isAdmin.value) {
    // You just left: there's nothing here for you to look at any more.
    open.value = false
    await spaces.load()
    return
  }
  const problem = error.value
  await loadMembers()
  error.value = problem
}
</script>

<template>
  <v-dialog v-model="open" max-width="620" scrollable>
    <v-card :title="`People in ${space?.name ?? ''}`">
      <v-card-text>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
          error
        }}</v-alert>
        <p v-if="!busy && members.length === 0" class="text-medium-emphasis mb-3">
          Nobody has been added yet.
        </p>
        <v-list v-else lines="two">
          <v-list-item v-for="m in members" :key="m.userId" class="px-0">
            <v-list-item-title>{{ m.displayName }}</v-list-item-title>
            <v-list-item-subtitle>{{ m.username }}</v-list-item-subtitle>
            <template #append>
              <v-select
                :model-value="m.role"
                :items="ROLE_ITEMS"
                item-title="title"
                item-value="value"
                :aria-label="`Role for ${m.displayName}`"
                density="compact"
                hide-details
                :disabled="busy || isLastOwner(members, m.userId)"
                style="width: 130px"
                @update:model-value="(v: SpaceRole) => setRole(m, v)"
              />
              <v-btn
                icon="mdi-close"
                size="small"
                variant="text"
                class="ml-1"
                :aria-label="`Remove ${m.displayName}`"
                :disabled="busy || isLastOwner(members, m.userId)"
                @click="removing = m"
              />
            </template>
          </v-list-item>
        </v-list>
        <p v-if="members.some((m) => isLastOwner(members, m.userId))" class="text-caption mb-3">
          Every Space needs an owner. Add another owner before changing the only one.
        </p>

        <v-divider class="my-3" />
        <h3 class="text-subtitle-1 mb-2">Add someone</h3>
        <v-form @submit.prevent="add">
          <v-select
            v-if="isAdmin"
            v-model="pickedUser"
            :items="choices"
            label="Person"
            :no-data-text="'Everyone is already here. Add new users under Settings.'"
          />
          <v-text-field
            v-else
            v-model="username"
            label="Their username"
            autocomplete="off"
            hint="Ask them, or your administrator, for the exact username."
            persistent-hint
            class="mb-3"
          />
          <v-select
            v-model="role"
            :items="ROLE_ITEMS"
            item-title="title"
            item-value="value"
            label="They can"
            :item-props="withSubtitle"
          />
          <v-btn
            type="submit"
            color="primary"
            :loading="busy"
            :disabled="isAdmin ? !pickedUser : !username.trim()"
            >Add</v-btn
          >
        </v-form>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="open = false">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="!!removing" max-width="400" @update:model-value="removing = null">
    <v-card :title="`Remove ${removing?.displayName ?? ''}?`">
      <v-card-text>
        They will no longer see anything in {{ space?.name }}. Their sign-in stays.
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="removing = null">Keep</v-btn>
        <v-btn color="error" @click="remove">Remove</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
