<script setup lang="ts">
import { PAD_HOST, type PadHostApi } from '@pond/sdk'
import { onErrorCaptured, provide, ref, type Component } from 'vue'
import { api } from '../../api'
import { useSpacesStore } from '../../stores/spaces'

/**
 * Where a pad's component is shown. It gives the component its host (`usePadHost()`), bound to
 * this pad and the active Space, and keeps a pad's mistake from breaking the page around it.
 */
const props = defineProps<{
  padId: string
  component: Component
  props?: Record<string, unknown>
}>()
const spaces = useSpacesStore()
const failed = ref(false)

const base = () => `/api/spaces/${spaces.active?.id}/lilypads/${props.padId}`
const withQuery = (path: string, q?: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined) p.set(k, String(v))
  const s = p.toString()
  return `${base()}${path}${s ? `?${s}` : ''}`
}
const host: PadHostApi = {
  padId: props.padId,
  get spaceId() {
    return spaces.active?.id ?? ''
  },
  get canEdit() {
    return spaces.active?.role === 'owner' || spaces.active?.role === 'editor'
  },
  api: {
    get: (path, query) => api(withQuery(path, query)),
    post: (path, body) => api(withQuery(path), { method: 'POST', body: body ?? {} }),
    put: (path, body) => api(withQuery(path), { method: 'PUT', body: body ?? {} }),
    patch: (path, body) => api(withQuery(path), { method: 'PATCH', body: body ?? {} }),
    del: (path) => api(withQuery(path), { method: 'DELETE' }),
  },
}
provide(PAD_HOST, host)

onErrorCaptured(() => {
  failed.value = true
  return false
})
</script>

<template>
  <v-alert v-if="failed" type="warning" variant="tonal" density="compact"
    >This part of the app had a problem and was hidden.</v-alert
  >
  <component :is="component" v-else v-bind="props.props ?? {}" />
</template>
