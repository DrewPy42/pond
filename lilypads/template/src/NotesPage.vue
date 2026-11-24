<script setup lang="ts">
import { usePadHost } from '@pond/sdk'
import { onMounted, ref, watch } from 'vue'

interface Note {
  id: string
  title: string
  body: string | null
  done: boolean
}

const host = usePadHost()
const notes = ref<Note[]>([])
const title = ref('')
const search = ref('')
const error = ref('')

async function load() {
  try {
    const r = await host.api.get<{ notes: Note[] }>('/notes', { q: search.value || undefined })
    notes.value = r.notes
    error.value = ''
  } catch {
    error.value = "Couldn't load notes."
  }
}
async function add() {
  if (!title.value.trim()) return
  await host.api.post('/notes', { title: title.value })
  title.value = ''
  await load()
}
async function toggle(n: Note) {
  await host.api.patch(`/notes/${n.id}`, { done: !n.done })
  await load()
}
async function remove(n: Note) {
  await host.api.del(`/notes/${n.id}`)
  await load()
}
onMounted(load)
watch(search, load)
</script>

<template>
  <h1 class="text-h5 mb-4">Notes</h1>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>
  <v-text-field
    v-model="search"
    label="Search"
    prepend-inner-icon="mdi-magnify"
    clearable
    hide-details
    density="compact"
    class="mb-3"
    style="max-width: 360px"
  />
  <v-form v-if="host.canEdit" class="d-flex ga-2 mb-4" @submit.prevent="add">
    <v-text-field v-model="title" label="New note" hide-details density="compact" />
    <v-btn type="submit" color="primary">Add</v-btn>
  </v-form>
  <p v-if="notes.length === 0" class="text-medium-emphasis">No notes yet.</p>
  <v-list v-else lines="one">
    <v-list-item v-for="n in notes" :key="n.id">
      <template #prepend>
        <v-checkbox-btn
          :model-value="n.done"
          :disabled="!host.canEdit"
          :aria-label="`Mark ${n.title} done`"
          @update:model-value="toggle(n)"
        />
      </template>
      <v-list-item-title :class="{ 'text-decoration-line-through': n.done }">{{
        n.title
      }}</v-list-item-title>
      <template v-if="host.canEdit" #append>
        <v-btn
          icon="mdi-delete-outline"
          variant="text"
          :aria-label="`Delete ${n.title}`"
          @click="remove(n)"
        />
      </template>
    </v-list-item>
  </v-list>
</template>
