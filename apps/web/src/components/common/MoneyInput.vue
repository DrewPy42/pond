<script setup lang="ts">
import { formatCents, parseCents } from '@pond/shared'
import { ref, watch } from 'vue'

/**
 * A text field for a money amount that edits integer cents. The value is `null` while the box is
 * empty or not a valid amount. Accepts "12.34", "$1,234.50", "(5.00)", "-5".
 */
const props = withDefaults(
  defineProps<{
    modelValue: number | null
    label?: string
    allowNegative?: boolean
    errorMessages?: string[]
  }>(),
  { label: 'Amount', allowNegative: true, errorMessages: () => [] },
)
const emit = defineEmits<{ 'update:modelValue': [cents: number | null] }>()

const text = ref(props.modelValue === null ? '' : formatCents(props.modelValue))
const problem = ref('')

watch(
  () => props.modelValue,
  (cents) => {
    // Only overwrite the text when the outside value really changed (e.g. a form reset).
    const parsed = (): number | null => {
      try {
        return text.value.trim() === '' ? null : parseCents(text.value)
      } catch {
        return null
      }
    }
    if (cents !== parsed()) text.value = cents === null ? '' : formatCents(cents)
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
    problem.value = props.allowNegative
      ? 'Enter an amount like 12.34'
      : 'Enter a positive amount like 12.34'
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
    :error-messages="problem ? [problem] : errorMessages"
    @update:model-value="onInput"
    @blur="onBlur"
  />
</template>
