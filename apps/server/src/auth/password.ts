import argon2 from 'argon2'

/**
 * Argon2id at the OWASP minimum profile (19 MiB, t=2, p=1). That stays well under ~500 ms on a
 * Pi 4 while remaining memory-hard. Revisit if timing on real hardware says there is headroom.
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const

export const MIN_PASSWORD_LENGTH = 12

/** A small deny list; the length rule does most of the work. Compared case-insensitively. */
const COMMON = new Set(
  [
    'password1234',
    'password12345',
    'passwordpassword',
    '123456789012',
    '1234567890123',
    'qwertyuiop12',
    'qwertyuiopasdf',
    'iloveyou1234',
    'letmein12345',
    'welcome12345',
    'administrator',
    'changemechangeme',
    'correcthorsebatterystaple',
  ].map((s) => s.toLowerCase()),
)

export type PasswordProblem = 'too_short' | 'too_common' | 'contains_username'

export function checkPasswordStrength(password: string, username?: string): PasswordProblem | null {
  if ([...password].length < MIN_PASSWORD_LENGTH) return 'too_short'
  const lower = password.toLowerCase()
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return 'too_common'
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) {
    return 'contains_username'
  }
  return null
}

export const hashPassword = (password: string): Promise<string> => argon2.hash(password, OPTIONS)

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

/**
 * Verified against a throwaway hash when the user doesn't exist, so a login attempt takes
 * about the same time whether or not the username is real.
 */
let dummyHash: Promise<string> | undefined
export function verifyAgainstDummy(password: string): Promise<boolean> {
  dummyHash ??= hashPassword('pond-dummy-password-for-timing')
  return dummyHash.then((h) => verifyPassword(h, password))
}
