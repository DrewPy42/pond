<script setup lang="ts">
/** One dialog pattern for every form: title, content, Cancel / Save, busy state and an error line. */
withDefaults(
  defineProps<{
    title: string
    submitLabel?: string
    busy?: boolean
    error?: string
    maxWidth?: number
    submitDisabled?: boolean
  }>(),
  { submitLabel: 'Save', busy: false, error: '', maxWidth: 560, submitDisabled: false },
)
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ submit: [] }>()
</script>

<template>
  <v-dialog v-model="open" :max-width="maxWidth" scrollable>
    <v-card>
      <v-form @submit.prevent="emit('submit')">
        <v-card-title class="pt-4">{{ title }}</v-card-title>
        <v-card-text>
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{
            error
          }}</v-alert>
          <slot />
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <slot name="actions-left" />
          <v-spacer />
          <v-btn variant="text" :disabled="busy" @click="open = false">Cancel</v-btn>
          <v-btn type="submit" color="primary" :loading="busy" :disabled="submitDisabled">{{
            submitLabel
          }}</v-btn>
        </v-card-actions>
      </v-form>
    </v-card>
  </v-dialog>
</template>
