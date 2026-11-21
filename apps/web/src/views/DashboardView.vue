<script setup lang="ts">
import { onMounted } from 'vue'
import { useHealthStore } from '../stores/health'

const store = useHealthStore()
onMounted(() => store.load())
</script>

<template>
  <h1 class="text-h5 mb-4">Welcome to Pond</h1>
  <v-card border flat max-width="520">
    <v-card-title class="text-subtitle-1">Server status</v-card-title>
    <v-card-text>
      <v-alert v-if="store.error" type="error" variant="tonal" density="compact">
        Problem talking to the Pond server ({{ store.error }}).
      </v-alert>
      <div v-else-if="store.health" data-testid="server-ok">
        <v-icon icon="mdi-check-circle" color="secondary" class="mr-1" />
        Running · version {{ store.health.version }} · schema {{ store.health.schemaVersion }}
      </div>
      <v-progress-circular v-else indeterminate size="20" />
    </v-card-text>
  </v-card>
</template>
