<script setup lang="ts">
/** What a report leaves out or assumes, said plainly above the numbers. */
defineProps<{ otherCurrencyAccounts: number }>()
</script>

<template>
  <v-alert
    v-if="$slots.default?.().length"
    type="info"
    variant="tonal"
    density="compact"
    class="mb-3"
  >
    <slot />
  </v-alert>
  <v-alert
    v-if="otherCurrencyAccounts > 0"
    type="info"
    variant="tonal"
    density="compact"
    class="mb-3"
  >
    {{ otherCurrencyAccounts }} account(s) in another currency are not included. Pond doesn't
    convert currencies.
  </v-alert>
</template>
