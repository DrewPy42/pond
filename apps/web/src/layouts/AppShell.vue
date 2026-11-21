<script setup lang="ts">
import { ref } from 'vue'
import { useTheme } from 'vuetify'
import { coreNav } from '../router'

const drawer = ref(true)
const theme = useTheme()
const isDark = () => theme.global.current.value.dark
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
    <!-- LilyPad sidebar entries mount here (M5). -->
  </v-navigation-drawer>

  <v-app-bar flat color="surface" border="b">
    <v-app-bar-nav-icon aria-label="Toggle navigation" @click="drawer = !drawer" />
    <!-- Space switcher: real data arrives with Spaces in M1. -->
    <v-select
      class="space-switcher ml-2"
      label="Space"
      model-value="none"
      :items="[{ title: 'No Spaces yet', value: 'none' }]"
      density="compact"
      variant="outlined"
      hide-details
      disabled
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
  </v-app-bar>

  <v-main>
    <v-container fluid class="pa-6">
      <router-view />
    </v-container>
  </v-main>
</template>

<style scoped>
.space-switcher {
  max-width: 260px;
}
</style>
