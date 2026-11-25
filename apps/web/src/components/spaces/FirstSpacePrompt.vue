<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '../../stores/auth'
import NewSpaceDialog from './NewSpaceDialog.vue'

/** Shown in place of a page when there's no Space to show it for. */
const auth = useAuthStore()
const creating = ref(false)
</script>

<template>
  <v-card variant="outlined" class="pa-6 text-center mx-auto" max-width="560">
    <template v-if="auth.user?.isAdmin">
      <p class="text-h6 mb-2">Create your first Space</p>
      <p class="text-medium-emphasis mb-4">
        A Space holds one set of money, such as your household or a business. Everything else in
        Pond lives inside one.
      </p>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="creating = true">New Space</v-btn>
      <NewSpaceDialog v-model="creating" />
    </template>
    <template v-else>
      <p class="text-h6 mb-2">You aren't in a Space yet</p>
      <p class="text-medium-emphasis">
        Ask your administrator to add you to one. Then reload this page.
      </p>
    </template>
  </v-card>
</template>
