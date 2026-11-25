<script setup lang="ts">
import type { BackupView, BackupWarning } from '@pond/shared'
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../../api'
import { warningText } from './backupText'

/** For admins: a backup that fails unnoticed is the real risk. */
const warning = ref<BackupWarning | null>(null)
const route = useRoute()

async function load() {
  try {
    warning.value = (await api<BackupView>('/api/backups')).warning
  } catch {
    // The page itself reports connection problems.
  }
}
onMounted(load)
watch(() => route.path, load)
</script>

<template>
  <v-alert v-if="warning" type="warning" class="mb-4">
    {{ warningText(warning) }}
    <router-link v-if="route.name !== 'settings'" to="/settings" class="ml-1 banner-link">
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
