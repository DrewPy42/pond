<script setup lang="ts">
import type { AuditEntryView } from '@pond/shared'
import { computed, ref } from 'vue'
import { api } from '../../api'
import { useAction } from '../../composables/useAction'
import { auditLine, type AuditNames } from './auditText'

/** For admins: what has happened in Pond, newest first. Read only. */
const props = withDefaults(defineProps<{ pageSize?: number }>(), { pageSize: 50 })

const { busy, error, run } = useAction()
const entries = ref<AuditEntryView[]>([])
const opened = ref(false)
const more = ref(false)
const names = ref<AuditNames>({ users: new Map(), spaces: new Map(), apps: new Map() })

type Named = { id: string; name?: string; displayName?: string }
/** A list that can't be loaded only means some names are missing. */
async function namesFrom(path: string, field: string): Promise<[string, string][]> {
  try {
    const r = await api<Record<string, Named[]>>(path)
    return (r[field] ?? []).map((x) => [x.id, x.displayName ?? x.name ?? ''])
  } catch {
    return []
  }
}
async function loadNames() {
  const [users, spaces, archived, apps] = await Promise.all([
    namesFrom('/api/users', 'users'),
    namesFrom('/api/spaces', 'spaces'),
    namesFrom('/api/spaces/archived', 'spaces'),
    namesFrom('/api/lilypads', 'pads'),
  ])
  names.value = {
    users: new Map(users),
    spaces: new Map([...spaces, ...archived]),
    apps: new Map(apps),
  }
}

/** The newest page, or the one after what is already shown. */
async function load(after?: AuditEntryView) {
  const query = new URLSearchParams({ limit: String(props.pageSize) })
  if (after) {
    query.set('before', after.at)
    query.set('beforeId', after.id)
  }
  const r = await run(() => api<{ entries: AuditEntryView[] }>(`/api/audit-log?${query}`))
  if (!r) return
  entries.value = after ? [...entries.value, ...r.entries] : r.entries
  more.value = r.entries.length === props.pageSize
  opened.value = true
}
async function open() {
  await loadNames()
  await load()
}

const lines = computed(() =>
  entries.value.map((e) => ({
    id: e.id,
    when: new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    ...auditLine(e, names.value),
  })),
)
</script>

<template>
  <h2 class="text-h6 mb-1">Activity log</h2>
  <p class="text-body-2 text-medium-emphasis mb-3">
    Sign-ins, changes to users and Spaces, backups and other important actions. Only administrators
    can see it.
  </p>
  <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>

  <v-btn v-if="!opened" variant="tonal" :loading="busy" @click="open">Show the activity log</v-btn>
  <template v-else>
    <v-btn variant="text" size="small" :loading="busy" class="mb-2" @click="open">Refresh</v-btn>
    <p v-if="!lines.length" class="text-medium-emphasis">Nothing has been recorded yet.</p>
    <v-card v-else border flat>
      <ul class="log">
        <li v-for="line in lines" :key="line.id">
          <div class="font-weight-medium">{{ line.what }}</div>
          <div class="text-body-2 text-medium-emphasis">{{ line.when }} · {{ line.who }}</div>
          <div v-if="line.details" class="text-body-2 details">{{ line.details }}</div>
        </li>
      </ul>
    </v-card>
    <v-btn v-if="more" variant="tonal" :loading="busy" class="mt-3" @click="load(entries.at(-1))"
      >Load more</v-btn
    >
  </template>
</template>

<style scoped>
.log {
  list-style: none;
  padding: 0;
}
.log li {
  padding: 10px 16px;
}
.log li + li {
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
/* File names and addresses can be long and have no spaces. */
.details {
  overflow-wrap: anywhere;
}
</style>
