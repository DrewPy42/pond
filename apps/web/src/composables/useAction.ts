import { ref } from 'vue'
import { errorMessage } from '../api'

/** Runs an async action with a busy flag and a friendly error message (for dialogs and buttons). */
export function useAction() {
  const busy = ref(false)
  const error = ref('')
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    busy.value = true
    error.value = ''
    try {
      return await fn()
    } catch (e) {
      error.value = errorMessage(e)
      return undefined
    } finally {
      busy.value = false
    }
  }
  return { busy, error, run }
}
