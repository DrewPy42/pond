import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, ApiError } from '../api'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
  totpEnabled: boolean
}
interface MeResponse {
  user: SessionUser
  totpEnrollmentRequired: boolean
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<SessionUser | null>(null)
  const enrollmentRequired = ref(false)
  const loaded = ref(false)
  const setupRequired = ref(false)

  const isAuthenticated = computed(() => user.value !== null)

  function apply(r: MeResponse | null) {
    user.value = r?.user ?? null
    enrollmentRequired.value = r?.totpEnrollmentRequired ?? false
  }

  async function load() {
    try {
      apply(await api<MeResponse>('/api/auth/me'))
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e
      apply(null)
      setupRequired.value = (
        await api<{ setupRequired: boolean }>('/api/setup/status')
      ).setupRequired
    }
    loaded.value = true
  }

  async function login(username: string, password: string, code?: string) {
    apply(
      await api<MeResponse>('/api/auth/login', {
        method: 'POST',
        body: { username, password, code },
      }),
    )
  }

  async function setup(body: { username: string; displayName: string; password: string }) {
    apply(await api<MeResponse>('/api/setup', { method: 'POST', body }))
    setupRequired.value = false
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: {} })
    apply(null)
  }

  /** Called after TOTP is confirmed so route guards stop forcing enrollment. */
  function markTotpEnabled() {
    if (user.value) user.value.totpEnabled = true
    enrollmentRequired.value = false
  }

  return {
    user,
    enrollmentRequired,
    loaded,
    setupRequired,
    isAuthenticated,
    load,
    login,
    setup,
    logout,
    markTotpEnabled,
  }
})
