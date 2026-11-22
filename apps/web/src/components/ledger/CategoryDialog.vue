<script setup lang="ts">
import type { CategoryView } from '@pond/shared'
import { ref, watch } from 'vue'
import { FormDialog } from '../common'
import { useAction } from '../../composables/useAction'
import { useSpaceApi } from '../../composables/useSpaceApi'

const props = defineProps<{ category: CategoryView | null }>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ saved: [] }>()

const space = useSpaceApi()
const { busy, error, run } = useAction()
const kinds = [
  { title: 'Expense', value: 'expense' },
  { title: 'Income', value: 'income' },
  { title: 'Transfer', value: 'transfer' },
]
const form = ref({ name: '', kind: 'expense' as CategoryView['kind'], taxLine: '' })

watch(open, (isOpen) => {
  if (!isOpen) return
  const c = props.category
  form.value = c
    ? { name: c.name, kind: c.kind, taxLine: c.taxLine ?? '' }
    : { name: '', kind: 'expense', taxLine: '' }
  error.value = ''
})

async function save() {
  const f = form.value
  const done = await run(async () => {
    if (props.category) {
      await space.patch(`/categories/${props.category.id}`, {
        name: f.name,
        kind: f.kind,
        taxLine: f.taxLine || null,
      })
    } else {
      await space.post('/categories', {
        name: f.name,
        kind: f.kind,
        taxLine: f.taxLine || undefined,
      })
    }
    return true
  })
  if (done) {
    open.value = false
    emit('saved')
  }
}
</script>

<template>
  <FormDialog
    v-model="open"
    :title="category ? 'Edit category' : 'Add category'"
    :busy="busy"
    :error="error"
    :max-width="440"
    @submit="save"
  >
    <v-text-field v-model="form.name" label="Name" autofocus required />
    <v-select v-model="form.kind" :items="kinds" label="Kind" />
    <v-text-field
      v-model="form.taxLine"
      label="Tax line (optional)"
      hint="For example: Schedule C, Line 8"
      persistent-hint
    />
  </FormDialog>
</template>
