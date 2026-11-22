<script setup lang="ts">
import type { CategoryView } from '@pond/shared'
import { onMounted, ref, watch } from 'vue'
import { DataTable } from '../components/common'
import CategoryDialog from '../components/ledger/CategoryDialog.vue'
import { useAction } from '../composables/useAction'
import { useSpaceApi } from '../composables/useSpaceApi'

const space = useSpaceApi()
const { busy, error, run } = useAction()
const categories = ref<CategoryView[]>([])
const showArchived = ref(false)
const editing = ref<CategoryView | null>(null)
const open = ref(false)

const headers = [
  { title: 'Name', key: 'name' },
  { title: 'Kind', key: 'kind' },
  { title: 'Tax line', key: 'taxLine' },
  { title: '', key: 'actions', align: 'end' as const, sortable: false },
]

async function load() {
  if (!space.spaceId.value) return
  const r = await run(() =>
    space.get<{ categories: CategoryView[] }>(`/categories?includeArchived=${showArchived.value}`),
  )
  if (r) categories.value = r.categories
}
onMounted(load)
watch([space.spaceId, showArchived], load)

const edit = (c: CategoryView | null) => {
  editing.value = c
  open.value = true
}
async function toggleArchive(c: CategoryView) {
  await run(() => space.patch(`/categories/${c.id}`, { archived: c.archivedAt === null }))
  await load()
}
</script>

<template>
  <div class="d-flex align-center mb-4 ga-3 flex-wrap">
    <h1 class="text-h5">Categories</h1>
    <v-spacer />
    <v-switch
      v-model="showArchived"
      label="Show archived"
      density="compact"
      hide-details
      color="secondary"
    />
    <v-btn v-if="space.canEdit.value" color="primary" prepend-icon="mdi-plus" @click="edit(null)"
      >Add category</v-btn
    >
  </div>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{
    error
  }}</v-alert>

  <DataTable
    :headers="headers"
    :items="categories"
    :loading="busy"
    empty-text="No categories in this Space yet."
  >
    <template #item.name="{ item }">
      <span :class="{ 'text-medium-emphasis': item.archivedAt }">{{ item.name }}</span>
      <v-chip v-if="item.archivedAt" size="x-small" class="ml-2">Archived</v-chip>
    </template>
    <template #item.kind="{ item }">{{
      item.kind.replace(/^./, (c: string) => c.toUpperCase())
    }}</template>
    <template #item.taxLine="{ item }">{{ item.taxLine ?? '' }}</template>
    <template #item.actions="{ item }">
      <template v-if="space.canEdit.value">
        <v-btn variant="text" size="small" @click="edit(item)">Edit</v-btn>
        <v-btn variant="text" size="small" @click="toggleArchive(item)">{{
          item.archivedAt ? 'Restore' : 'Archive'
        }}</v-btn>
      </template>
    </template>
  </DataTable>

  <CategoryDialog v-model="open" :category="editing" @saved="load" />
</template>
