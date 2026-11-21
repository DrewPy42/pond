import { createHash, randomBytes } from 'node:crypto'
import { generateSecret, generateURI, verifySync } from 'otplib'

export const newTotpSecret = (): string => generateSecret()

export const totpUri = (secret: string, username: string): string =>
  generateURI({ issuer: 'Pond', label: username, secret })

/** Accepts the previous/next 30-second step to tolerate clock drift. */
export function verifyTotp(secret: string, token: string): boolean {
  if (!/^\d{6}$/.test(token)) return false
  try {
    return verifySync({ secret, token, epochTolerance: 30 }).valid
  } catch {
    return false
  }
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789' // no look-alikes

/** Ten single-use codes like `k3f9a-x2m7q`. Shown once; only hashes are stored. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10)
    const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
    return `${chars.slice(0, 5)}-${chars.slice(5)}`
  })
}

export const normalizeRecoveryCode = (code: string): string => code.trim().toLowerCase()

export const hashRecoveryCode = (code: string): string =>
  createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex')
