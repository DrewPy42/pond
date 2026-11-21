import { healthSchema, type Health } from '@pond/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useHealthStore = defineStore('health', () => {
  const health = ref<Health | null>(null)
  const error = ref<string | null>(null)

  async function load() {
    try {
      const res = await fetch('/api/health')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      health.value = healthSchema.parse(await res.json())
      error.value = null
    } catch (e) {
      health.value = null
      error.value = e instanceof Error ? e.message : 'Unknown error'
    }
  }
  return { health, error, load }
})
