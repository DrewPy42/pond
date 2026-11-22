import type { NewUser, SpaceRecord } from '../repos/types.js'

/**
 * Builders for mock data. Each returns a complete, valid object with sensible defaults; a test
 * overrides only the fields it cares about, so the test reads as the scenario it describes.
 * Ids are predictable (`user-1`, `space-2`, ...) which keeps failures readable.
 */
let n = 0
const next = (prefix: string) => `${prefix}-${++n}`

/** Call in `beforeEach` if a test depends on exact ids. */
export const resetFactoryIds = (): void => {
  n = 0
}

/** A stand-in password hash; the fakes never verify it. Real hashing is tested separately. */
export const FAKE_HASH = '$argon2id$v=19$m=19456,t=2,p=1$fake$fake'

export function buildUser(over: Partial<NewUser> = {}): NewUser {
  const id = over.id ?? next('user')
  return {
    id,
    username: `user${id.replace(/\D/g, '')}`,
    displayName: `User ${id}`,
    email: null,
    passwordHash: FAKE_HASH,
    isAdmin: false,
    ...over,
  }
}

export function buildSpace(over: Partial<Omit<SpaceRecord, 'archivedAt'>> = {}) {
  const id = over.id ?? next('space')
  return { id, name: `Space ${id}`, type: 'personal' as const, currency: 'USD', ...over }
}
