import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, errorMessage } from '../api'

/**
 * "Enter your password again." Core owns this dialog and the password never leaves it: whatever
 * asked (including a LilyPad) only learns whether it succeeded.
 */
export const useReauthStore = defineStore('reauth', () => {
  const open = ref(false)
  const busy = ref(false)
  const error = ref('')
  let waiting: Promise<boolean> | null = null
  let answer: ((ok: boolean) => void) | null = null

  /** Resolves true once the password is accepted, false if the person cancels. */
  function request(): Promise<boolean> {
    // Several requests refused at once share one dialog.
    waiting ??= new Promise<boolean>((resolve) => {
      answer = resolve
      error.value = ''
      open.value = true
    })
    return waiting
  }

  function finish(ok: boolean) {
    open.value = false
    const resolve = answer
    answer = null
    waiting = null
    resolve?.(ok)
  }

  async function submit(password: string) {
    busy.value = true
    error.value = ''
    try {
      await api('/api/auth/reauth', { method: 'POST', body: { password } })
      finish(true)
    } catch (e) {
      error.value =
        (e as { code?: string }).code === 'invalid_credentials'
          ? "That password isn't right."
          : errorMessage(e)
    } finally {
      busy.value = false
    }
  }

  return { open, busy, error, request, submit, cancel: () => finish(false) }
})
