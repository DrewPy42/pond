<script setup lang="ts">
/**
 * Entering or removing a tax ID. The value is `undefined` to keep what's on file, `null` to remove
 * it, or the new text.
 */
const props = defineProps<{ modelValue: string | null | undefined; onFile: string | null }>()
const emit = defineEmits<{ 'update:modelValue': [value: string | null | undefined] }>()
</script>

<template>
  <v-text-field
    :model-value="props.modelValue ?? ''"
    label="Tax ID (SSN, EIN or other)"
    autocomplete="off"
    :disabled="props.modelValue === null"
    :hint="
      props.onFile
        ? `On file: ${props.onFile}. Leave empty to keep it.`
        : 'Optional. Stored encrypted.'
    "
    persistent-hint
    @update:model-value="emit('update:modelValue', $event || undefined)"
  />
  <v-checkbox
    v-if="props.onFile"
    :model-value="props.modelValue === null"
    label="Remove the tax ID on file"
    density="compact"
    hide-details
    @update:model-value="emit('update:modelValue', $event ? null : undefined)"
  />
</template>
