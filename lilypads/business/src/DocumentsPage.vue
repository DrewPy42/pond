<script setup lang="ts">
import { usePadHost } from '@pond/sdk'
import { computed, onMounted, ref } from 'vue'
import { DOC_TYPES, MAX_DOCUMENT_BYTES, labelOf, type DocumentView, type PersonView } from './types'
import { errorCode, items } from './ui'

const host = usePadHost()
const documents = ref<DocumentView[]>([])
const people = ref<PersonView[]>([])
const loading = ref(true)
const error = ref('')
const filterType = ref<string | null>(null)
const filterYear = ref('')
const filterPerson = ref<string | null>(null)
const peopleItems = computed(() =>
  people.value.map((p) => ({ value: p.id, title: `${p.firstName} ${p.lastName}` })),
)
const filtering = computed(() => !!(filterType.value || filterYear.value || filterPerson.value))
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const validYear = (y: string) => /^\d{4}$/.test(y) && Number(y) >= 1990 && Number(y) <= 2200

async function load() {
  try {
    documents.value = (
      await host.api.get<{ documents: DocumentView[] }>('/documents', {
        type: filterType.value ?? undefined,
        taxYear: validYear(filterYear.value) ? filterYear.value : undefined,
        personId: filterPerson.value ?? undefined,
      })
    ).documents
    error.value = ''
  } catch {
    error.value = "Couldn't load documents."
  } finally {
    loading.value = false
  }
}

// ----- upload -----
const adding = ref(false)
const file = ref<File | null>(null)
const type = ref('tax_form')
const year = ref('')
const person = ref<string | null>(null)
const note = ref('')
const addError = ref('')
const busy = ref(false)

function openAdd() {
  file.value = null
  type.value = 'tax_form'
  year.value = ''
  person.value = null
  note.value = ''
  addError.value = ''
  adding.value = true
}
const tooBig = computed(() => !!file.value && file.value.size > MAX_DOCUMENT_BYTES)
async function upload() {
  if (!file.value || tooBig.value) return
  busy.value = true
  addError.value = ''
  try {
    await host.api.upload('/documents', file.value, {
      filename: file.value.name.slice(-200),
      type: type.value,
      taxYear: year.value || undefined,
      personId: person.value ?? undefined,
      note: note.value || undefined,
    })
    adding.value = false
    await load()
  } catch (e) {
    const code = errorCode(e)
    addError.value =
      code === 'unsupported_file_type'
        ? 'Only PDF, JPEG and PNG files can be saved here.'
        : code === 'file_too_large'
          ? 'That file is over 15 MB.'
          : "Couldn't save the file. Check the tax year."
  } finally {
    busy.value = false
  }
}

async function download(d: DocumentView) {
  try {
    await host.api.download(`/documents/${d.id}/download`)
  } catch {
    error.value = "Couldn't download that file."
  }
}

const removing = ref<DocumentView | null>(null)
async function remove() {
  if (!removing.value) return
  try {
    await host.api.del(`/documents/${removing.value.id}`)
    removing.value = null
    await load()
  } catch {
    error.value = "Couldn't delete that document."
  }
}

onMounted(async () => {
  people.value = await host.api
    .get<{ people: PersonView[] }>('/people')
    .then((r) => r.people)
    .catch(() => [])
  await load()
})
</script>

<template>
  <div class="d-flex align-center mb-4">
    <h1 class="text-h5 mr-auto">Documents</h1>
    <v-btn color="primary" prepend-icon="mdi-upload" @click="openAdd">Add a document</v-btn>
  </div>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>
  <div class="d-flex flex-wrap ga-3 mb-2">
    <v-select
      v-model="filterType"
      :items="items(DOC_TYPES)"
      label="Type"
      clearable
      density="compact"
      style="max-width: 220px"
      @update:model-value="load"
    />
    <v-text-field
      v-model="filterYear"
      label="Tax year"
      inputmode="numeric"
      maxlength="4"
      density="compact"
      style="max-width: 140px"
      @change="load"
    />
    <v-select
      v-if="people.length"
      v-model="filterPerson"
      :items="peopleItems"
      label="Person"
      clearable
      density="compact"
      style="max-width: 260px"
      @update:model-value="load"
    />
  </div>
  <v-progress-linear v-if="loading" indeterminate />
  <p v-else-if="documents.length === 0" class="text-medium-emphasis">
    {{
      filtering
        ? 'No documents match.'
        : 'No documents yet. Keep tax forms, contracts and receipts here; they are stored encrypted.'
    }}
  </p>
  <v-list v-else lines="two">
    <v-list-item v-for="d in documents" :key="d.id">
      <v-list-item-title>{{ d.filename }}</v-list-item-title>
      <v-list-item-subtitle>
        {{
          [
            labelOf(DOC_TYPES, d.docType),
            d.taxYear,
            d.personName,
            size(d.size),
            `added ${d.addedOn}`,
            d.note,
          ]
            .filter(Boolean)
            .join(' · ')
        }}
      </v-list-item-subtitle>
      <template #append>
        <v-btn
          icon="mdi-download"
          variant="text"
          :aria-label="`Download ${d.filename}`"
          @click="download(d)"
        />
        <v-btn
          icon="mdi-delete-outline"
          variant="text"
          :aria-label="`Delete ${d.filename}`"
          @click="removing = d"
        />
      </template>
    </v-list-item>
  </v-list>

  <v-dialog v-model="adding" max-width="480">
    <v-card title="Add a document">
      <v-card-text>
        <v-alert v-if="addError" type="error" variant="tonal" density="compact" class="mb-3">{{
          addError
        }}</v-alert>
        <v-file-input
          :model-value="file"
          label="File (PDF, JPEG or PNG, up to 15 MB)"
          accept="application/pdf,image/jpeg,image/png"
          :error-messages="tooBig ? ['That file is over 15 MB.'] : []"
          @update:model-value="file = (Array.isArray($event) ? $event[0] : $event) ?? null"
        />
        <v-select v-model="type" :items="items(DOC_TYPES)" label="Type" />
        <v-text-field
          v-model="year"
          label="Tax year (optional)"
          inputmode="numeric"
          maxlength="4"
        />
        <v-select
          v-if="people.length"
          v-model="person"
          :items="peopleItems"
          label="Person (optional)"
          clearable
        />
        <v-text-field v-model="note" label="Note (optional)" maxlength="300" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="adding = false">Cancel</v-btn>
        <v-btn color="primary" :loading="busy" :disabled="!file || tooBig" @click="upload"
          >Save</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="!!removing" max-width="400" @update:model-value="removing = null">
    <v-card :title="`Delete ${removing?.filename ?? ''}?`">
      <v-card-text>The file is removed from Pond. It can't be undone.</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="removing = null">Keep</v-btn>
        <v-btn color="error" @click="remove">Delete</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
