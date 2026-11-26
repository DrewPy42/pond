<script setup lang="ts">
import type { BackupView } from '@pond/shared'
import { onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../../api'
import { warningText } from './backupText'
import { backupWarnings } from './warnings'

/** For admins: a backup that fails unnoticed is the real risk. */
const route = useRoute()

async function load() {
  try {
    backupWarnings.value = (await api<BackupView>('/api/backups')).warnings
  } catch {
    // The page itself reports connection problems.
  }
}
onMounted(load)
watch(() => route.path, load)
</script>

<template>
  <v-alert v-if="backupWarnings.length" type="warning" class="mb-4">
    <div v-for="w in backupWarnings" :key="`${w.destination}-${w.kind}`">{{ warningText(w) }}</div>
    <router-link v-if="route.name !== 'settings'" to="/settings" class="banner-link">
      Check backups
    </router-link>
  </v-alert>
</template>

<style scoped>
/* Navy on the warning fill, like the rest of the banner. */
.banner-link {
  color: inherit;
}
</style>
