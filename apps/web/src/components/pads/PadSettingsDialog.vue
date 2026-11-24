<script setup lang="ts">
import type { PadSettingField, PadSettingsView } from '@pond/shared'
import { ref, watch } from 'vue'
import { api } from '../../api'
import { FormDialog } from '../common'
import { useAction } from '../../composables/useAction'

/** A pad's settings screen, drawn from the fields the pad declared (pads write no settings UI). */
const props = defineProps<{ spaceId: string; padId: string | null }>()
const open = defineModel<boolean>({ required: true })

const { busy, error, run } = useAction()
const view = ref<PadSettingsView | null>(null)
const values = ref<Record<string, string | number | boolean>>({})

watch(open, async (isOpen) => {
  if (!isOpen || !props.padId) return
  error.value = ''
  view.value = null
  const r = await run(() =>
    api<PadSettingsView>(`/api/spaces/${props.spaceId}/pads/${props.padId}/settings`),
  )
  if (r) {
    view.value = r
    values.value = Object.fromEntries(r.fields.map((f) => [f.key, f.value]))
  }
})

async function save() {
  const done = await run(() =>
    api(`/api/spaces/${props.spaceId}/pads/${props.padId}/settings`, {
      method: 'PUT',
      body: { values: values.value },
    }),
  )
  if (done) open.value = false
}
const hint = (f: PadSettingField) =>
  f.type === 'integer' && (f.min !== undefined || f.max !== undefined)
    ? `Between ${f.min ?? '…'} and ${f.max ?? '…'}`
    : undefined
</script>

<template>
  <FormDialog
    v-model="open"
    :title="`${view?.name ?? 'App'} settings`"
    :busy="busy"
    :error="error"
    :max-width="520"
    @submit="save"
  >
    <p v-if="view && view.fields.length === 0" class="text-medium-emphasis">
      This app has no settings for a Space.
    </p>
    <template v-for="f in view?.fields ?? []" :key="f.key">
      <v-switch
        v-if="f.type === 'boolean'"
        v-model="values[f.key] as boolean"
        :label="f.label"
        color="secondary"
        hide-details
        density="compact"
        class="mb-2"
      />
      <v-text-field
        v-else-if="f.type === 'string'"
        v-model="values[f.key] as string"
        :label="f.label"
        :counter="f.maxLength"
      />
      <v-text-field
        v-else-if="f.type === 'integer'"
        v-model.number="values[f.key] as number"
        :label="f.label"
        type="number"
        :hint="hint(f)"
        persistent-hint
      />
      <v-select
        v-else
        v-model="values[f.key] as string"
        :label="f.label"
        :items="f.options.map((o) => ({ title: o.label, value: o.value }))"
      />
    </template>
  </FormDialog>
</template>
