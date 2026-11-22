import { computed } from 'vue'
import { api } from '../api'
import { useSpacesStore } from '../stores/spaces'

/** API calls for the active Space: `get('/accounts')` -> GET /api/spaces/<id>/accounts. */
export function useSpaceApi() {
  const spaces = useSpacesStore()
  const spaceId = computed(() => spaces.active?.id ?? null)
  const canEdit = computed(
    () => spaces.active?.role === 'owner' || spaces.active?.role === 'editor',
  )
  const base = (spaceOverride?: string) => {
    const id = spaceOverride ?? spaceId.value
    if (!id) throw new Error('No active Space')
    return `/api/spaces/${id}`
  }
  return {
    spaceId,
    canEdit,
    currency: computed(() => spaces.active?.currency ?? 'USD'),
    get: <T>(path: string, space?: string) => api<T>(base(space) + path),
    post: <T>(path: string, body: unknown, space?: string) =>
      api<T>(base(space) + path, { method: 'POST', body }),
    patch: <T>(path: string, body: unknown, space?: string) =>
      api<T>(base(space) + path, { method: 'PATCH', body }),
    put: <T>(path: string, body: unknown, space?: string) =>
      api<T>(base(space) + path, { method: 'PUT', body }),
    del: <T>(path: string, space?: string) =>
      api<T>(base(space) + path, { method: 'DELETE', body: undefined }),
  }
}
