import type { Role } from '../types.js'

/**
 * Repository interfaces: the only way routes, middleware and services read or write data.
 * Real implementations (repos/drizzle.ts) wrap Drizzle; tests use in-memory fakes
 * (testing/fakeRepos.ts). Both must pass the same contract suite (testing/repoContract.ts), so
 * a fake can't quietly behave differently from the database. All methods are synchronous
 * because better-sqlite3 is.
 *
 * Records are plain objects, deliberately not Drizzle's inferred types, so nothing above this
 * layer depends on the database library.
 */

export interface UserRecord {
  id: string
  username: string
  displayName: string
  email: string | null
  passwordHash: string
  totpSecretEnc: string | null
  totpEnabledAt: string | null
  isAdmin: boolean
  status: 'active' | 'disabled'
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}
export interface NewUser {
  id: string
  username: string
  displayName: string
  email?: string | null
  passwordHash: string
  isAdmin: boolean
}
export type UserPatch = Partial<
  Pick<
    UserRecord,
    | 'displayName'
    | 'email'
    | 'passwordHash'
    | 'totpSecretEnc'
    | 'totpEnabledAt'
    | 'isAdmin'
    | 'status'
    | 'lastLoginAt'
  >
>

/** Thrown by `create` when the username is already taken. */
export class DuplicateError extends Error {}
/** Thrown when a row refers to a parent that doesn't exist (foreign key). */
export class MissingParentError extends Error {}

export interface UserRepo {
  count(): number
  findById(id: string): UserRecord | undefined
  findByUsername(username: string): UserRecord | undefined
  /** Ordered by username. */
  list(): UserRecord[]
  /** Throws DuplicateError if the username exists. */
  create(user: NewUser): void
  /** Atomic: creates the user only if there are no users yet. Returns whether it did. */
  createIfNoUsers(user: NewUser): boolean
  update(id: string, patch: UserPatch): void
  /** Active admins other than `exceptId` (used to protect the last admin). */
  countActiveAdminsExcept(exceptId: string): number
}

export interface RecoveryCodeRecord {
  id: string
  userId: string
  codeHash: string
  usedAt: string | null
}
export interface RecoveryCodeRepo {
  /** Deletes the user's existing codes and stores these hashes. */
  replaceForUser(userId: string, hashes: { id: string; codeHash: string }[]): void
  findUnused(userId: string, codeHash: string): RecoveryCodeRecord | undefined
  markUsed(id: string, at: string): void
  countUnused(userId: string): number
}

export interface SessionRecord {
  id: string
  userId: string
  csrfHash: string
  expiresAt: string
  absoluteExpiresAt: string
  lastSeenAt: string
  reauthAt: string | null
  ip: string | null
  userAgent: string | null
}
export interface SessionRepo {
  /** Throws MissingParentError if the user doesn't exist. */
  create(session: Omit<SessionRecord, 'reauthAt'>): void
  findWithUser(id: string): { session: SessionRecord; user: UserRecord } | undefined
  touch(id: string, lastSeenAt: string, expiresAt: string): void
  setReauth(id: string, at: string): void
  delete(id: string): void
  /** Deletes all of a user's sessions, optionally keeping one. */
  deleteForUser(userId: string, exceptId?: string): void
}

export interface SpaceRecord {
  id: string
  name: string
  type: 'personal' | 'business'
  currency: string
  archivedAt: string | null
}
export interface MemberView {
  userId: string
  username: string
  displayName: string
  role: Role
}
export interface SpaceRepo {
  create(space: Omit<SpaceRecord, 'archivedAt'>): void
  findById(id: string): SpaceRecord | undefined
  /** Ordered by name. */
  listAll(): SpaceRecord[]
  /** Spaces the user is a member of, with their role. Ordered by name. */
  listForUser(userId: string): { space: SpaceRecord; role: Role }[]
  update(id: string, patch: Partial<Pick<SpaceRecord, 'name' | 'archivedAt'>>): void

  getRole(spaceId: string, userId: string): Role | undefined
  /** Ordered by username. */
  listMembers(spaceId: string): MemberView[]
  /** Adds or changes a membership. Throws MissingParentError for an unknown space or user. */
  setMember(spaceId: string, userId: string, role: Role): 'added' | 'changed'
  removeMember(spaceId: string, userId: string): void
  countOwners(spaceId: string): number
}

export interface AuditRecord {
  id: string
  at: string
  actorType: 'user' | 'system' | 'lilypad'
  actorId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  spaceId: string | null
  meta: Record<string, unknown> | null
}
export interface AuditRepo {
  add(entry: AuditRecord): void
  /** Newest first. `before` is an ISO timestamp (exclusive). */
  list(opts: { limit: number; before?: string }): AuditRecord[]
}

export interface Repos {
  users: UserRepo
  recoveryCodes: RecoveryCodeRepo
  sessions: SessionRepo
  spaces: SpaceRepo
  audit: AuditRepo
  system: { schemaVersion(): number }
  /** Several writes as one unit. Real: a SQLite transaction (rolls back if `fn` throws). */
  transaction<T>(fn: () => T): T
}
