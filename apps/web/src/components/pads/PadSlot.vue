<script setup lang="ts">
import { PAD_HOST, type PadHostApi } from '@pond/sdk'
import { onErrorCaptured, provide, ref, type Component } from 'vue'
import { api, apiDownload, apiUpload } from '../../api'
import { withReauth } from '../../composables/padFiles'
import { useReauthStore } from '../../stores/reauth'
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
const reauth = useReauthStore()
const failed = ref(false)

const base = () => `/api/spaces/${spaces.active?.id}/lilypads/${props.padId}`
type Query = Record<string, string | number | boolean | undefined>
const withQuery = (path: string, q?: Query) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined) p.set(k, String(v))
  const s = p.toString()
  return `${base()}${path}${s ? `?${s}` : ''}`
}
// If a route wants the password again, Pond asks for it (not the pad) and retries.
const guarded = <T,>(request: () => Promise<T>) => withReauth(request, reauth.request)
const call = <T,>(url: () => string, opts?: { method: string; body?: unknown }) =>
  guarded(() => api<T>(url(), opts))
const host: PadHostApi = {
  padId: props.padId,
  get spaceId() {
    return spaces.active?.id ?? ''
  },
  get canEdit() {
    return spaces.active?.role === 'owner' || spaces.active?.role === 'editor'
  },
  api: {
    get: <T,>(path: string, query?: Query) => call<T>(() => withQuery(path, query)),
    post: <T,>(path: string, body?: unknown) =>
      call<T>(() => withQuery(path), { method: 'POST', body: body ?? {} }),
    put: <T,>(path: string, body?: unknown) =>
      call<T>(() => withQuery(path), { method: 'PUT', body: body ?? {} }),
    patch: <T,>(path: string, body?: unknown) =>
      call<T>(() => withQuery(path), { method: 'PATCH', body: body ?? {} }),
    del: <T,>(path: string) => call<T>(() => withQuery(path), { method: 'DELETE' }),
    upload: <T,>(path: string, file: Blob, query?: Query) =>
      guarded(() => apiUpload<T>(withQuery(path, query), file)),
    download: (path: string, query?: Query) => guarded(() => apiDownload(withQuery(path, query))),
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
