<script setup lang="ts">
import { ref, watch } from 'vue'
import { api } from '../../api'
import { SPACE_TYPE_ITEMS } from '../../composables/spaces'
import { useAction } from '../../composables/useAction'
import { useAuthStore } from '../../stores/auth'
import { useSpacesStore } from '../../stores/spaces'
import { FormDialog } from '../common'

/** Creating a Space (administrator only). The new Space becomes the one you're looking at. */
const open = defineModel<boolean>({ required: true })
const withSubtitle = (i: { subtitle: string }) => ({ subtitle: i.subtitle })
const emit = defineEmits<{ created: [] }>()
const auth = useAuthStore()
const spaces = useSpacesStore()
const { busy, error, run } = useAction()
const name = ref('')
const type = ref<'personal' | 'business'>('personal')

watch(open, (isOpen) => {
  if (!isOpen) return
  name.value = ''
  type.value = 'personal'
  error.value = ''
})

async function create() {
  if (!name.value.trim()) return
  const made = await run(() =>
    api<{ space: { id: string } }>('/api/spaces', {
      method: 'POST',
      // Whoever creates it is listed as its first owner.
      body: { name: name.value, type: type.value, ownerUserId: auth.user?.id },
    }),
  )
  if (!made) return
  await spaces.load()
  spaces.select(made.space.id)
  open.value = false
  emit('created')
}
</script>

<template>
  <FormDialog
    v-model="open"
    title="New Space"
    submit-label="Create"
    :busy="busy"
    :error="error"
    :submit-disabled="!name.trim()"
    :max-width="460"
    @submit="create"
  >
    <v-text-field v-model="name" label="Name" maxlength="80" autofocus />
    <v-select
      v-model="type"
      :items="SPACE_TYPE_ITEMS"
      item-title="title"
      item-value="value"
      label="Kind"
      hint="This can't be changed later. It decides the starting categories and which apps fit."
      persistent-hint
      :item-props="withSubtitle"
    />
  </FormDialog>
</template>
