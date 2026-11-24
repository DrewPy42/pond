<script setup lang="ts">
import { formatCents, parseCents } from '@pond/shared'
import { ref, watch } from 'vue'

/**
 * A dollars-and-cents box that edits integer cents. The value is `null` while the box is empty or
 * isn't an amount. (A pad can't import the web app's own money box, so this is a small copy.)
 */
const props = defineProps<{ modelValue: number | null; label: string; allowNegative?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [cents: number | null] }>()

const text = ref(props.modelValue === null ? '' : formatCents(props.modelValue))
const problem = ref('')

watch(
  () => props.modelValue,
  (cents) => {
    // Only rewrite the box when the outside value really changed (e.g. the form was reset).
    const typed = ((): number | null => {
      try {
        return text.value.trim() === '' ? null : parseCents(text.value)
      } catch {
        return null
      }
    })()
    if (cents !== typed) text.value = cents === null ? '' : formatCents(cents)
  },
)

function onInput(value: string) {
  text.value = value
  if (value.trim() === '') {
    problem.value = ''
    emit('update:modelValue', null)
    return
  }
  try {
    const cents = parseCents(value)
    if (!props.allowNegative && cents < 0) throw new RangeError('negative')
    problem.value = ''
    emit('update:modelValue', cents)
  } catch {
    problem.value = 'Enter an amount like 12.34'
    emit('update:modelValue', null)
  }
}
function onBlur() {
  if (!problem.value && props.modelValue !== null) text.value = formatCents(props.modelValue)
}
</script>

<template>
  <v-text-field
    :model-value="text"
    :label="label"
    inputmode="decimal"
    prefix="$"
    :error-messages="problem ? [problem] : []"
    @update:model-value="onInput"
    @blur="onBlur"
  />
</template>
