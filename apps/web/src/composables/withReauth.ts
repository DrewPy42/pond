import { ApiError } from '../api'
import { useReauthStore } from '../stores/reauth'

/**
 * Runs an action that may need the password again: if the server asks, show the shared dialog and
 * try once more. Returns undefined if the person cancels.
 */
export function useReauthRetry() {
  const reauth = useReauthStore()
  return async function withReauth<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauth_required')) throw e
      return (await reauth.request()) ? fn() : undefined
    }
  }
}
