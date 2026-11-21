<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppShell from './layouts/AppShell.vue'
import AuthLayout from './layouts/AuthLayout.vue'

const route = useRoute()
const router = useRouter()
// Don't render a layout until the first navigation (and its auth guard) has resolved.
const ready = ref(false)
router.isReady().then(() => (ready.value = true))
</script>

<template>
  <v-app>
    <template v-if="ready">
      <AuthLayout v-if="route.meta.layout === 'auth'">
        <router-view />
      </AuthLayout>
      <AppShell v-else />
    </template>
  </v-app>
</template>
