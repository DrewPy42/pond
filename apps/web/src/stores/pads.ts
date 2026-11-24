import type { PadClientDefinition, PadPage, PadSidebarItem, PadWidget } from '@pond/sdk'
import type { SpacePad } from '@pond/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api'
import { padClients } from '../lilypads/registry'

/** The pads running in the active Space, joined with their web code from the registry. */
export const usePadsStore = defineStore('pads', () => {
  const enabled = ref<SpacePad[]>([])
  const spaceId = ref<string | null>(null)

  async function load(id: string | null) {
    spaceId.value = id
    if (!id) {
      enabled.value = []
      return
    }
    try {
      enabled.value = (await api<{ pads: SpacePad[] }>(`/api/spaces/${id}/pads`)).pads
    } catch {
      enabled.value = []
    }
  }

  const clientFor = (padId: string): PadClientDefinition | undefined => padClients[padId]
  const isEnabled = (padId: string) => enabled.value.some((p) => p.id === padId)

  const sidebar = computed(() =>
    enabled.value.flatMap((p) =>
      (clientFor(p.id)?.sidebar ?? []).map((i: PadSidebarItem) => ({
        ...i,
        padId: p.id,
        to: `/p/${p.id}/${i.path}`,
      })),
    ),
  )
  const widgets = computed(() =>
    enabled.value.flatMap((p) =>
      (clientFor(p.id)?.widgets ?? []).map((w: PadWidget) => ({ ...w, padId: p.id, name: p.name })),
    ),
  )
  const transactionPanels = computed(() =>
    enabled.value.flatMap((p) =>
      (clientFor(p.id)?.transactionPanels ?? []).map((w: PadWidget) => ({ ...w, padId: p.id })),
    ),
  )
  const pageFor = (padId: string, path: string): PadPage | undefined =>
    isEnabled(padId) ? clientFor(padId)?.pages?.find((p) => p.path === path) : undefined

  return { enabled, spaceId, load, isEnabled, sidebar, widgets, transactionPanels, pageFor }
})
