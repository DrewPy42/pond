import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'

export interface SpaceSummary {
  id: string
  name: string
  type: 'personal' | 'business'
  currency: string
  role: 'owner' | 'editor' | 'viewer'
}

const KEY = 'pond.activeSpace'
const read = (): string | null => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export const useSpacesStore = defineStore('spaces', () => {
  const spaces = ref<SpaceSummary[]>([])
  const activeId = ref<string | null>(read())
  const active = computed(
    () => spaces.value.find((s) => s.id === activeId.value) ?? spaces.value[0] ?? null,
  )

  async function load() {
    spaces.value = (await api<{ spaces: SpaceSummary[] }>('/api/spaces')).spaces
    if (!spaces.value.some((s) => s.id === activeId.value))
      activeId.value = spaces.value[0]?.id ?? null
  }
  function select(id: string) {
    activeId.value = id
    try {
      localStorage.setItem(KEY, id)
    } catch {
      /* storage unavailable: selection just won't persist */
    }
  }
  function reset() {
    spaces.value = []
    activeId.value = null
  }
  return { spaces, active, activeId, load, select, reset }
})
