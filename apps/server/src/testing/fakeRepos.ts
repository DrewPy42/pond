import {
  DuplicateError,
  MissingParentError,
  type AuditRecord,
  type RecoveryCodeRecord,
  type Repos,
  type SessionRecord,
  type SpaceRecord,
  type UserRecord,
} from '../repos/types.js'
import type { Role } from '../types.js'

/**
 * In-memory fakes of every repository: plain Maps and arrays, no database. They mimic the real
 * repositories' rules (unique usernames, parent rows must exist, ordering) and are checked
 * against the same contract suite (repoContract.ts). `transaction` just runs the function in
 * order; it does not roll back.
 */
export function createFakeRepos(now: () => Date = () => new Date(), schemaVersion = 1): Repos {
  const iso = () => now().toISOString()
  const users = new Map<string, UserRecord>()
  const codes = new Map<string, RecoveryCodeRecord>()
  const sessions = new Map<string, SessionRecord>()
  const spaces = new Map<string, SpaceRecord>()
  const members = new Map<string, Role>() // key: `${spaceId}|${userId}`
  const audit: AuditRecord[] = []
  const key = (s: string, u: string) => `${s}|${u}`
  const byName =
    <T>(f: (x: T) => string) =>
    (a: T, b: T) =>
      f(a).localeCompare(f(b))

  const insertUser = (u: Parameters<Repos['users']['create']>[0]) => {
    if ([...users.values()].some((x) => x.username === u.username)) {
      throw new DuplicateError('username taken')
    }
    users.set(u.id, {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email ?? null,
      passwordHash: u.passwordHash,
      totpSecretEnc: null,
      totpEnabledAt: null,
      isAdmin: u.isAdmin,
      status: 'active',
      lastLoginAt: null,
      createdAt: iso(),
      updatedAt: iso(),
    })
  }

  return {
    users: {
      count: () => users.size,
      findById: (id) => users.get(id),
      findByUsername: (name) => [...users.values()].find((u) => u.username === name),
      list: () => [...users.values()].sort(byName((u) => u.username)),
      create: insertUser,
      createIfNoUsers(u) {
        if (users.size > 0) return false
        insertUser(u)
        return true
      },
      update(id, patch) {
        const u = users.get(id)
        if (u) users.set(id, { ...u, ...patch, updatedAt: iso() })
      },
      countActiveAdminsExcept: (exceptId) =>
        [...users.values()].filter((u) => u.isAdmin && u.status === 'active' && u.id !== exceptId)
          .length,
    },

    recoveryCodes: {
      replaceForUser(userId, hashes) {
        for (const [id, c] of codes) if (c.userId === userId) codes.delete(id)
        for (const h of hashes) {
          codes.set(h.id, { id: h.id, userId, codeHash: h.codeHash, usedAt: null })
        }
      },
      findUnused: (userId, codeHash) =>
        [...codes.values()].find(
          (c) => c.userId === userId && c.codeHash === codeHash && c.usedAt === null,
        ),
      markUsed(id, at) {
        const c = codes.get(id)
        if (c) codes.set(id, { ...c, usedAt: at })
      },
      countUnused: (userId) =>
        [...codes.values()].filter((c) => c.userId === userId && c.usedAt === null).length,
    },

    sessions: {
      create(s) {
        if (!users.has(s.userId)) throw new MissingParentError('unknown user')
        sessions.set(s.id, { ...s, reauthAt: null })
      },
      findWithUser(id) {
        const session = sessions.get(id)
        const user = session && users.get(session.userId)
        return session && user ? { session, user } : undefined
      },
      touch(id, lastSeenAt, expiresAt) {
        const s = sessions.get(id)
        if (s) sessions.set(id, { ...s, lastSeenAt, expiresAt })
      },
      setReauth(id, at) {
        const s = sessions.get(id)
        if (s) sessions.set(id, { ...s, reauthAt: at })
      },
      delete: (id) => void sessions.delete(id),
      deleteForUser(userId, exceptId) {
        for (const [id, s] of sessions)
          if (s.userId === userId && id !== exceptId) sessions.delete(id)
      },
    },

    spaces: {
      create: (s) => void spaces.set(s.id, { ...s, archivedAt: null }),
      findById: (id) => spaces.get(id),
      listAll: () => [...spaces.values()].sort(byName((s) => s.name)),
      listForUser: (userId) =>
        [...members]
          .filter(([k]) => k.endsWith(`|${userId}`))
          .map(([k, role]) => ({ space: spaces.get(k.split('|')[0]!)!, role }))
          .sort(byName((r) => r.space.name)),
      update(id, patch) {
        const s = spaces.get(id)
        if (s) spaces.set(id, { ...s, ...patch })
      },
      getRole: (spaceId, userId) => members.get(key(spaceId, userId)),
      listMembers: (spaceId) =>
        [...members]
          .filter(([k]) => k.startsWith(`${spaceId}|`))
          .map(([k, role]) => {
            const u = users.get(k.split('|')[1]!)!
            return { userId: u.id, username: u.username, displayName: u.displayName, role }
          })
          .sort(byName((m) => m.username)),
      setMember(spaceId, userId, role) {
        if (!spaces.has(spaceId) || !users.has(userId)) {
          throw new MissingParentError('unknown space or user')
        }
        const had = members.has(key(spaceId, userId))
        members.set(key(spaceId, userId), role)
        return had ? 'changed' : 'added'
      },
      removeMember: (spaceId, userId) => void members.delete(key(spaceId, userId)),
      countOwners: (spaceId) =>
        [...members].filter(([k, r]) => k.startsWith(`${spaceId}|`) && r === 'owner').length,
    },

    audit: {
      add: (e) => void audit.push({ ...e }),
      list: ({ limit, before }) =>
        audit
          .filter((e) => !before || e.at < before)
          .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
          .slice(0, limit),
    },

    system: { schemaVersion: () => schemaVersion },
    transaction: (fn) => fn(),
  }
}
