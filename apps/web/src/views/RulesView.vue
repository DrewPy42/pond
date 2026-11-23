<script setup lang="ts">
import type { AccountView, CategoryView, RuleRunSummary, RuleView } from '@pond/shared'
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import RuleDialog from '../components/rules/RuleDialog.vue'
import { actionText, conditionText, type Lookups } from '../components/rules/ruleText'
import { useAction } from '../composables/useAction'
import { useSpaceApi } from '../composables/useSpaceApi'
import { useSpacesStore } from '../stores/spaces'

const space = useSpaceApi()
const spacesStore = useSpacesStore()
const { busy, error, run } = useAction()
const rules = ref<RuleView[]>([])
const accounts = ref<AccountView[]>([])
const categories = ref<CategoryView[]>([])
const editing = ref<RuleView | null>(null)
const dialogOpen = ref(false)
const notice = ref('')

const lookups = computed<Lookups>(() => ({
  accounts: new Map(accounts.value.map((a) => [a.id, a.name])),
  categories: new Map(categories.value.map((c) => [c.id, c.name])),
  spaces: new Map(spacesStore.spaces.map((s) => [s.id, s.name])),
}))

async function load() {
  if (!space.spaceId.value) return
  const r = await run(async () => {
    const [rs, as, cs] = await Promise.all([
      space.get<{ rules: RuleView[] }>('/rules'),
      space.get<{ accounts: AccountView[] }>('/accounts'),
      space.get<{ categories: CategoryView[] }>('/categories?includeArchived=true'),
    ])
    return { rs, as, cs }
  })
  if (r) {
    rules.value = r.rs.rules
    accounts.value = r.as.accounts
    categories.value = r.cs.categories
  }
}
onMounted(load)
watch(space.spaceId, load)

const edit = (r: RuleView | null) => {
  editing.value = r
  dialogOpen.value = true
}
async function toggle(r: RuleView) {
  await run(() => space.patch(`/rules/${r.id}`, { enabled: !r.enabled }))
  await load()
}
async function remove(r: RuleView) {
  if (!window.confirm(`Delete the rule "${r.name}"?`)) return
  await run(() => space.del(`/rules/${r.id}`))
  await load()
}
async function runNow() {
  notice.value = ''
  const r = await run(() =>
    api<{ summary: RuleRunSummary }>(`/api/spaces/${space.spaceId.value}/rules/run`, {
      method: 'POST',
      body: {},
    }),
  )
  if (r)
    notice.value = `Checked ${r.summary.examined} uncategorized transactions; ${r.summary.changed} changed.`
}
</script>

<template>
  <div class="d-flex align-center mb-2 ga-3 flex-wrap">
    <h1 class="text-h5">Rules</h1>
    <v-spacer />
    <template v-if="space.canEdit.value">
      <v-btn variant="outlined" prepend-icon="mdi-play-outline" :loading="busy" @click="runNow"
        >Run on uncategorized</v-btn
      >
      <v-btn color="primary" prepend-icon="mdi-plus" @click="edit(null)">Add rule</v-btn>
    </template>
  </div>
  <p class="text-body-2 text-medium-emphasis mb-4">
    Rules categorize new transactions automatically, from your bank or a CSV import. They never
    change transactions you have edited.
  </p>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{
    error
  }}</v-alert>
  <v-alert v-if="notice" type="info" variant="tonal" density="compact" class="mb-4" role="status">{{
    notice
  }}</v-alert>
  <p v-if="!busy && rules.length === 0" class="text-medium-emphasis">
    No rules yet. Add one to start categorizing automatically.
  </p>

  <v-card
    v-for="r in rules"
    :key="r.id"
    border
    flat
    class="mb-3"
    :class="{ 'opacity-60': !r.enabled }"
  >
    <v-card-title class="d-flex align-center ga-2 flex-wrap">
      <span>{{ r.name }}</span>
      <v-chip size="x-small">Priority {{ r.priority }}</v-chip>
      <v-chip v-if="!r.enabled" size="x-small">Off</v-chip>
    </v-card-title>
    <v-card-text>
      <div class="text-caption text-medium-emphasis">When</div>
      <ul class="pl-4 mb-2">
        <li v-for="(c, i) in r.conditions" :key="i">{{ conditionText(c, lookups) }}</li>
      </ul>
      <div class="text-caption text-medium-emphasis">Then</div>
      <ul class="pl-4">
        <li v-for="(a, i) in r.actions" :key="i">{{ actionText(a, lookups) }}</li>
      </ul>
    </v-card-text>
    <v-card-actions v-if="space.canEdit.value">
      <v-btn variant="text" size="small" @click="edit(r)">Edit</v-btn>
      <v-btn variant="text" size="small" @click="toggle(r)">{{
        r.enabled ? 'Turn off' : 'Turn on'
      }}</v-btn>
      <v-spacer />
      <v-btn variant="text" size="small" @click="remove(r)">Delete</v-btn>
    </v-card-actions>
  </v-card>

  <RuleDialog
    v-model="dialogOpen"
    :rule="editing"
    :accounts="accounts"
    :categories="categories.filter((c) => !c.archivedAt)"
    @saved="load"
  />
</template>
