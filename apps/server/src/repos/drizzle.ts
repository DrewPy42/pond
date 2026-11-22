import { and, asc, count, desc, eq, isNull, lt, ne } from 'drizzle-orm'
import { schemaVersion, type DbHandle } from '../db/index.js'
import { auditLog, recoveryCodes, sessions, spaceMembers, spaces, users } from '../db/schema.js'
import {
  DuplicateError,
  MissingParentError,
  type AuditRecord,
  type Repos,
  type SpaceRecord,
  type UserRecord,
} from './types.js'

/** Real repositories: the only place (with db/ and migrations) that talks to Drizzle/SQLite. */
export function createDrizzleRepos(handle: DbHandle, now: () => Date = () => new Date()): Repos {
  const db = handle.db
  const iso = () => now().toISOString()

  const isUnique = (e: unknown) => String((e as Error)?.message).includes('UNIQUE constraint')
  const isFk = (e: unknown) => String((e as Error)?.message).includes('FOREIGN KEY constraint')

  const toUser = (r: typeof users.$inferSelect): UserRecord => ({ ...r })
  const toSpace = (r: typeof spaces.$inferSelect): SpaceRecord => ({
    id: r.id,
    name: r.name,
    type: r.type,
    currency: r.currency,
    archivedAt: r.archivedAt,
  })

  return {
    users: {
      count: () => db.select({ n: count() }).from(users).get()?.n ?? 0,
      findById: (id) => {
        const r = db.select().from(users).where(eq(users.id, id)).get()
        return r && toUser(r)
      },
      findByUsername: (username) => {
        const r = db.select().from(users).where(eq(users.username, username)).get()
        return r && toUser(r)
      },
      list: () => db.select().from(users).orderBy(asc(users.username)).all().map(toUser),
      create(u) {
        try {
          db.insert(users)
            .values({ ...u, email: u.email ?? null, createdAt: iso(), updatedAt: iso() })
            .run()
        } catch (e) {
          if (isUnique(e)) throw new DuplicateError('username taken')
          throw e
        }
      },
      createIfNoUsers(u) {
        return handle.sqlite.transaction(() => {
          if ((db.select({ n: count() }).from(users).get()?.n ?? 0) > 0) return false
          db.insert(users)
            .values({ ...u, email: u.email ?? null, createdAt: iso(), updatedAt: iso() })
            .run()
          return true
        })()
      },
      update(id, patch) {
        db.update(users)
          .set({ ...patch, updatedAt: iso() })
          .where(eq(users.id, id))
          .run()
      },
      countActiveAdminsExcept: (exceptId) =>
        db
          .select({ n: count() })
          .from(users)
          .where(and(eq(users.isAdmin, true), eq(users.status, 'active'), ne(users.id, exceptId)))
          .get()?.n ?? 0,
    },

    recoveryCodes: {
      replaceForUser(userId, hashes) {
        db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run()
        for (const h of hashes) {
          db.insert(recoveryCodes)
            .values({ id: h.id, userId, codeHash: h.codeHash, createdAt: iso() })
            .run()
        }
      },
      findUnused: (userId, codeHash) =>
        db
          .select()
          .from(recoveryCodes)
          .where(
            and(
              eq(recoveryCodes.userId, userId),
              eq(recoveryCodes.codeHash, codeHash),
              isNull(recoveryCodes.usedAt),
            ),
          )
          .get(),
      markUsed: (id, at) =>
        void db.update(recoveryCodes).set({ usedAt: at }).where(eq(recoveryCodes.id, id)).run(),
      countUnused: (userId) =>
        db
          .select({ n: count() })
          .from(recoveryCodes)
          .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
          .get()?.n ?? 0,
    },

    sessions: {
      create(s) {
        try {
          db.insert(sessions)
            .values({ ...s, createdAt: iso() })
            .run()
        } catch (e) {
          if (isFk(e)) throw new MissingParentError('unknown user')
          throw e
        }
      },
      findWithUser(id) {
        const r = db
          .select({ s: sessions, u: users })
          .from(sessions)
          .innerJoin(users, eq(users.id, sessions.userId))
          .where(eq(sessions.id, id))
          .get()
        return r && { session: { ...r.s }, user: toUser(r.u) }
      },
      touch: (id, lastSeenAt, expiresAt) =>
        void db.update(sessions).set({ lastSeenAt, expiresAt }).where(eq(sessions.id, id)).run(),
      setReauth: (id, at) =>
        void db.update(sessions).set({ reauthAt: at }).where(eq(sessions.id, id)).run(),
      delete: (id) => void db.delete(sessions).where(eq(sessions.id, id)).run(),
      deleteForUser: (userId, exceptId) =>
        void db
          .delete(sessions)
          .where(
            exceptId
              ? and(eq(sessions.userId, userId), ne(sessions.id, exceptId))
              : eq(sessions.userId, userId),
          )
          .run(),
    },

    spaces: {
      create: (s) =>
        void db
          .insert(spaces)
          .values({ ...s, createdAt: iso(), updatedAt: iso() })
          .run(),
      findById: (id) => {
        const r = db.select().from(spaces).where(eq(spaces.id, id)).get()
        return r && toSpace(r)
      },
      listAll: () => db.select().from(spaces).orderBy(asc(spaces.name)).all().map(toSpace),
      listForUser: (userId) =>
        db
          .select({ s: spaces, role: spaceMembers.role })
          .from(spaceMembers)
          .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
          .where(eq(spaceMembers.userId, userId))
          .orderBy(asc(spaces.name))
          .all()
          .map((r) => ({ space: toSpace(r.s), role: r.role })),
      update: (id, patch) =>
        void db
          .update(spaces)
          .set({ ...patch, updatedAt: iso() })
          .where(eq(spaces.id, id))
          .run(),
      getRole: (spaceId, userId) =>
        db
          .select({ role: spaceMembers.role })
          .from(spaceMembers)
          .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
          .get()?.role,
      listMembers: (spaceId) =>
        db
          .select({
            userId: users.id,
            username: users.username,
            displayName: users.displayName,
            role: spaceMembers.role,
          })
          .from(spaceMembers)
          .innerJoin(users, eq(users.id, spaceMembers.userId))
          .where(eq(spaceMembers.spaceId, spaceId))
          .orderBy(asc(users.username))
          .all(),
      setMember(spaceId, userId, role) {
        const existing = db
          .select({ r: spaceMembers.role })
          .from(spaceMembers)
          .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
          .get()
        try {
          if (existing) {
            db.update(spaceMembers)
              .set({ role, updatedAt: iso() })
              .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
              .run()
            return 'changed'
          }
          db.insert(spaceMembers)
            .values({ spaceId, userId, role, createdAt: iso(), updatedAt: iso() })
            .run()
          return 'added'
        } catch (e) {
          if (isFk(e)) throw new MissingParentError('unknown space or user')
          throw e
        }
      },
      removeMember: (spaceId, userId) =>
        void db
          .delete(spaceMembers)
          .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
          .run(),
      countOwners: (spaceId) =>
        db
          .select({ n: count() })
          .from(spaceMembers)
          .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.role, 'owner')))
          .get()?.n ?? 0,
    },

    audit: {
      add: (e) =>
        void db
          .insert(auditLog)
          .values({ ...e, createdAt: iso() })
          .run(),
      list: ({ limit, before }) =>
        db
          .select()
          .from(auditLog)
          .where(before ? lt(auditLog.at, before) : undefined)
          .orderBy(desc(auditLog.at), desc(auditLog.id))
          .limit(limit)
          .all()
          .map((r): AuditRecord => ({
            id: r.id,
            at: r.at,
            actorType: r.actorType,
            actorId: r.actorId,
            action: r.action,
            targetType: r.targetType,
            targetId: r.targetId,
            spaceId: r.spaceId,
            meta: (r.meta as Record<string, unknown> | null) ?? null,
          })),
    },

    system: { schemaVersion: () => schemaVersion(handle) },
    transaction: (fn) => handle.sqlite.transaction(fn)(),
  }
}
