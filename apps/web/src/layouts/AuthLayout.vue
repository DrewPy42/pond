<script setup lang="ts">
import { useTheme } from 'vuetify'

const theme = useTheme()
</script>

<template>
  <v-main class="d-flex align-center justify-center">
    <v-card width="440" max-width="94vw" border flat class="pa-6">
      <img
        :src="
          theme.global.current.value.dark ? '/brand/pond-logo-dark.svg' : '/brand/pond-logo.svg'
        "
        alt="Pond"
        height="40"
        class="mb-6"
      />
      <slot />
    </v-card>
  </v-main>
</template>
