<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTheme } from 'vuetify'
import ReauthDialog from '../components/common/ReauthDialog.vue'
import FirstSpacePrompt from '../components/spaces/FirstSpacePrompt.vue'
import { coreNav } from '../router'
import { useAuthStore } from '../stores/auth'
import { usePadsStore } from '../stores/pads'
import { useSpacesStore } from '../stores/spaces'

const drawer = ref(true)
const theme = useTheme()
const isDark = () => theme.global.current.value.dark
const auth = useAuthStore()
const spaces = useSpacesStore()
const pads = usePadsStore()
const router = useRouter()
const route = useRoute()
// Every page but Settings is about a Space, so without one they'd only be empty or broken.
const needsSpace = computed(
  () => spaces.loaded && spaces.spaces.length === 0 && route.name !== 'settings',
)
onMounted(() => spaces.load())
// Pads running in the active Space add their sidebar entries, widgets and panels.
watch(
  () => spaces.active?.id ?? null,
  (id) => pads.load(id),
  { immediate: true },
)

async function signOut() {
  await auth.logout()
  spaces.reset()
  await router.replace({ name: 'login' })
}

const toggleTheme = () => theme.change(isDark() ? 'light' : 'dark')
</script>

<template>
  <v-navigation-drawer v-model="drawer" color="surface">
    <div class="pa-4">
      <img
        :src="isDark() ? '/brand/pond-logo-dark.svg' : '/brand/pond-logo.svg'"
        alt="Pond"
        height="36"
      />
    </div>
    <v-list nav density="comfortable">
      <v-list-item
        v-for="item in coreNav"
        :key="item.name"
        :to="item.path"
        :prepend-icon="item.icon"
        :title="item.title"
        color="on-surface"
        rounded="lg"
      />
    </v-list>
    <v-list v-if="pads.sidebar.length" nav density="comfortable">
      <v-list-subheader>Apps</v-list-subheader>
      <v-list-item
        v-for="item in pads.sidebar"
        :key="`${item.padId}/${item.path}`"
        :to="item.to"
        :prepend-icon="item.icon"
        :title="item.title"
        color="on-surface"
        rounded="lg"
      />
    </v-list>
  </v-navigation-drawer>

  <v-app-bar flat color="surface" border="b">
    <v-app-bar-nav-icon aria-label="Toggle navigation" @click="drawer = !drawer" />
    <v-select
      class="space-switcher ml-2"
      label="Space"
      :model-value="spaces.active?.id ?? 'none'"
      :items="
        spaces.spaces.length
          ? spaces.spaces.map((s) => ({ title: s.name, value: s.id }))
          : [{ title: 'No Spaces yet', value: 'none' }]
      "
      density="compact"
      variant="outlined"
      hide-details
      :disabled="spaces.spaces.length === 0"
      @update:model-value="spaces.select($event)"
    />
    <v-spacer />
    <v-btn
      icon
      variant="text"
      :aria-label="isDark() ? 'Switch to light theme' : 'Switch to dark theme'"
      @click="toggleTheme"
    >
      <v-icon :icon="isDark() ? 'mdi-weather-sunny' : 'mdi-weather-night'" />
    </v-btn>
    <v-menu>
      <template #activator="{ props }">
        <v-btn
          v-bind="props"
          variant="text"
          prepend-icon="mdi-account-circle-outline"
          :aria-label="`Account menu for ${auth.user?.displayName}`"
        >
          {{ auth.user?.displayName }}
        </v-btn>
      </template>
      <v-list>
        <v-list-item prepend-icon="mdi-logout" title="Sign out" @click="signOut" />
      </v-list>
    </v-menu>
  </v-app-bar>

  <ReauthDialog />

  <v-main>
    <v-container fluid class="pa-6">
      <FirstSpacePrompt v-if="needsSpace" />
      <router-view v-else :key="spaces.spaces.length ? 'ready' : 'empty'" />
    </v-container>
  </v-main>
</template>

<style scoped>
.space-switcher {
  max-width: 260px;
}
</style>
