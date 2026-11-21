<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <h1 class="text-h5 mb-2">{{ title }}</h1>
  <p class="text-medium-emphasis">This page arrives in a later milestone.</p>
</template>
