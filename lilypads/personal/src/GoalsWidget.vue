<script setup lang="ts">
import { usePadHost } from '@pond/sdk/client'
import { formatMoney } from '@pond/shared'
import { onMounted, ref } from 'vue'

interface Goal {
  id: string
  name: string
  targetCents: number
  savedCents: number
  percent: number
}
const host = usePadHost()
const goals = ref<Goal[]>([])
const failed = ref(false)

onMounted(async () => {
  try {
    goals.value = (await host.api.get<{ goals: Goal[] }>('/goals')).goals.slice(0, 3)
  } catch {
    failed.value = true
  }
})
</script>

<template>
  <p v-if="failed" class="text-medium-emphasis">Couldn't load your goals.</p>
  <div v-else-if="goals.length">
    <div v-for="g in goals" :key="g.id" class="mb-2">
      <div class="d-flex">
        <span class="mr-auto">{{ g.name }}</span>
        <span class="text-medium-emphasis">{{ g.percent }}%</span>
      </div>
      <v-progress-linear
        :model-value="g.percent"
        color="secondary"
        height="6"
        rounded
        :aria-label="`${g.name}: ${g.percent} percent`"
      />
      <div class="text-caption text-medium-emphasis">
        {{ formatMoney(g.savedCents) }} of {{ formatMoney(g.targetCents) }}
      </div>
    </div>
    <router-link to="/p/personal/goals" class="text-body-2">All goals</router-link>
  </div>
  <p v-else class="text-medium-emphasis">
    No goals yet. <router-link to="/p/personal/goals">Start one</router-link>
  </p>
</template>
