import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { schemaVersion, type DbHandle } from '../db/index.js'
import { newId as defaultNewId } from '../db/ids.js'
import type { SplitSumRow } from '@pond/sdk'
import { createSqlitePadStore } from './padStore.js'
import { checkSplits } from '../ledger/splits.js'
import {
  accounts,
  auditLog,
  balanceSnapshots,
  categories,
  connections,
  importBatches,
  lilypadInstalls,
  lilypadJobRuns,
  lilypadMigrations,
  lilypadSpaceEnablement,
  rules,
  settings,
  recoveryCodes,
  sessions,
  spaceMembers,
  spaces,
  splits as splitsTable,
  transactions,
  transferLinks,
  users,
} from '../db/schema.js'
import {
  DuplicateError,
  MissingParentError,
  SplitInvariantError,
  type AccountRecord,
  type AuditRecord,
  type CategoryRecord,
  type NewSplit,
  type Repos,
  type RuleRecord,
  type SplitRecord,
  type TransactionRecord,
  type TransactionWithSplits,
  type SpaceRecord,
  type UserRecord,
} from './types.js'

/** Real repositories: the only place (with db/ and migrations) that talks to Drizzle/SQLite. */
export function createDrizzleRepos(
  handle: DbHandle,
  now: () => Date = () => new Date(),
  newId: () => string = defaultNewId,
): Repos {
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

  const toAccount = (r: typeof accounts.$inferSelect): AccountRecord => ({
    id: r.id,
    connectionId: r.connectionId,
    externalId: r.externalId,
    institutionName: r.institutionName,
    name: r.name,
    nickname: r.nickname,
    type: r.type,
    currency: r.currency,
    primarySpaceId: r.primarySpaceId,
    isManual: r.isManual,
    includeInNetWorth: r.includeInNetWorth,
    syncEnabled: r.syncEnabled,
    hidden: r.hidden,
    lastFour: r.lastFour,
    archivedAt: r.archivedAt,
  })
  const toCategory = (r: typeof categories.$inferSelect): CategoryRecord => ({
    id: r.id,
    spaceId: r.spaceId,
    parentId: r.parentId,
    name: r.name,
    kind: r.kind,
    taxLine: r.taxLine,
    sortOrder: r.sortOrder,
    archivedAt: r.archivedAt,
  })
  const toTxn = (r: typeof transactions.$inferSelect): TransactionRecord => ({
    id: r.id,
    accountId: r.accountId,
    externalId: r.externalId,
    source: r.source,
    date: r.date,
    postedAt: r.postedAt,
    transactedAt: r.transactedAt,
    amountCents: r.amountCents,
    descriptionRaw: r.descriptionRaw,
    payee: r.payee,
    memo: r.memo,
    pending: r.pending,
    status: r.status,
    private: r.private,
    needsReview: r.needsReview,
    userEdited: r.userEdited,
    supersededBy: r.supersededBy,
    importBatchId: r.importBatchId,
  })
  const toSplit = (r: typeof splitsTable.$inferSelect): SplitRecord => ({
    id: r.id,
    transactionId: r.transactionId,
    spaceId: r.spaceId,
    categoryId: r.categoryId,
    amountCents: r.amountCents,
    memo: r.memo,
    reimbursable: r.reimbursable,
    reimbursedAt: r.reimbursedAt,
  })
  const toRule = (r: typeof rules.$inferSelect): RuleRecord => ({
    id: r.id,
    spaceId: r.spaceId,
    name: r.name,
    priority: r.priority,
    enabled: r.enabled,
    conditions: r.conditions as RuleRecord['conditions'],
    actions: r.actions as RuleRecord['actions'],
    createdBy: r.createdBy,
  })
  const splitsOf = (transactionId: string): SplitRecord[] =>
    db
      .select()
      .from(splitsTable)
      .where(eq(splitsTable.transactionId, transactionId))
      .orderBy(asc(splitsTable.id))
      .all()
      .map(toSplit)
  const insertSplits = (transactionId: string, list: NewSplit[]) => {
    for (const sp of list) {
      db.insert(splitsTable)
        .values({
          id: sp.id,
          transactionId,
          spaceId: sp.spaceId,
          categoryId: sp.categoryId ?? null,
          amountCents: sp.amountCents,
          memo: sp.memo ?? null,
          reimbursable: sp.reimbursable ?? false,
          createdAt: iso(),
          updatedAt: iso(),
        })
        .run()
    }
  }
  const assertBalanced = (amountCents: number, list: readonly { amountCents: number }[]) => {
    const problem = checkSplits(amountCents, list)
    if (problem) throw new SplitInvariantError(problem)
  }
  const mapWrite = <T>(fn: () => T): T => {
    try {
      return fn()
    } catch (e) {
      if (isUnique(e)) throw new DuplicateError('duplicate')
      if (isFk(e)) throw new MissingParentError('unknown parent row')
      throw e
    }
  }

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
      deleteAll: () => void db.delete(sessions).run(),
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
      contents(spaceId) {
        const count = (query: string, ...params: string[]) =>
          (handle.sqlite.prepare(query).get(...params) as { n: number }).n
        // Every LilyPad table with a space_id column, found from the database itself, so data
        // left behind by an uninstalled pad still counts. Names are Pond's own, not input.
        const padTables = (
          handle.sqlite
            .prepare(
              "SELECT m.name AS name FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'space_id' WHERE m.type = 'table' AND m.name LIKE 'lp!_%' ESCAPE '!'",
            )
            .all() as { name: string }[]
        ).map((t) => t.name.replace(/"/g, ''))
        return {
          accounts: count('SELECT count(*) AS n FROM accounts WHERE primary_space_id = ?', spaceId),
          splits: count('SELECT count(*) AS n FROM splits WHERE space_id = ?', spaceId),
          appRows: padTables.reduce(
            (sum, name) =>
              sum + count(`SELECT count(*) AS n FROM "${name}" WHERE space_id = ?`, spaceId),
            0,
          ),
        }
      },
      delete(spaceId) {
        handle.sqlite.transaction(() => {
          db.delete(lilypadSpaceEnablement).where(eq(lilypadSpaceEnablement.spaceId, spaceId)).run()
          db.delete(lilypadJobRuns).where(eq(lilypadJobRuns.spaceId, spaceId)).run()
          db.delete(settings)
            .where(and(eq(settings.scope, 'space'), eq(settings.scopeId, spaceId)))
            .run()
          db.delete(rules).where(eq(rules.spaceId, spaceId)).run()
          db.delete(categories).where(eq(categories.spaceId, spaceId)).run()
          db.delete(spaceMembers).where(eq(spaceMembers.spaceId, spaceId)).run()
          db.delete(spaces).where(eq(spaces.id, spaceId)).run()
        })()
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
      list: ({ limit, before, beforeId }) =>
        db
          .select()
          .from(auditLog)
          .where(
            !before
              ? undefined
              : beforeId
                ? or(
                    lt(auditLog.at, before),
                    and(eq(auditLog.at, before), lt(auditLog.id, beforeId)),
                  )
                : lt(auditLog.at, before),
          )
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

    rules: {
      create: (r) =>
        mapWrite(
          () =>
            void db
              .insert(rules)
              .values({ ...r, createdAt: iso(), updatedAt: iso() })
              .run(),
        ),
      findById: (id) => {
        const r = db.select().from(rules).where(eq(rules.id, id)).get()
        return r && toRule(r)
      },
      listForSpace: (spaceId) =>
        db
          .select()
          .from(rules)
          .where(eq(rules.spaceId, spaceId))
          .orderBy(asc(rules.priority), asc(rules.id))
          .all()
          .map(toRule),
      update: (id, patch) =>
        void db
          .update(rules)
          .set({ ...patch, updatedAt: iso() })
          .where(eq(rules.id, id))
          .run(),
      delete: (id) => void db.delete(rules).where(eq(rules.id, id)).run(),
    },

    importBatches: {
      create: (b) =>
        mapWrite(
          () =>
            void db
              .insert(importBatches)
              .values({ ...b, createdAt: iso() })
              .run(),
        ),
      findById: (id) => {
        const r = db.select().from(importBatches).where(eq(importBatches.id, id)).get()
        return r && { ...r }
      },
      listForAccounts: (accountIds, opts) =>
        accountIds.length === 0
          ? []
          : db
              .select()
              .from(importBatches)
              .where(inArray(importBatches.accountId, accountIds))
              .orderBy(desc(importBatches.createdAt), desc(importBatches.id))
              .limit(opts?.limit ?? 50)
              .all()
              .map((r) => ({ ...r })),
    },

    connections: {
      create: (c) =>
        mapWrite(
          () =>
            void db
              .insert(connections)
              .values({ ...c, createdAt: iso(), updatedAt: iso() })
              .run(),
        ),
      findById: (id) => {
        const r = db.select().from(connections).where(eq(connections.id, id)).get()
        return (
          r && {
            id: r.id,
            label: r.label,
            accessUrlEnc: r.accessUrlEnc,
            createdBy: r.createdBy,
            status: r.status,
            lastSyncedAt: r.lastSyncedAt,
            lastError: r.lastError,
          }
        )
      },
      list: () =>
        db
          .select()
          .from(connections)
          .orderBy(asc(connections.label), asc(connections.id))
          .all()
          .map((r) => ({
            id: r.id,
            label: r.label,
            accessUrlEnc: r.accessUrlEnc,
            createdBy: r.createdBy,
            status: r.status,
            lastSyncedAt: r.lastSyncedAt,
            lastError: r.lastError,
          })),
      update: (id, patch) =>
        void db
          .update(connections)
          .set({ ...patch, updatedAt: iso() })
          .where(eq(connections.id, id))
          .run(),
    },

    accounts: {
      create: (a) =>
        mapWrite(
          () =>
            void db
              .insert(accounts)
              .values({
                id: a.id,
                name: a.name,
                type: a.type,
                currency: a.currency,
                connectionId: a.connectionId ?? null,
                externalId: a.externalId ?? null,
                syncEnabled: a.syncEnabled ?? false,
                institutionName: a.institutionName ?? null,
                nickname: a.nickname ?? null,
                primarySpaceId: a.primarySpaceId ?? null,
                isManual: a.isManual ?? true,
                includeInNetWorth: a.includeInNetWorth ?? true,
                hidden: a.hidden ?? false,
                lastFour: a.lastFour ?? null,
                createdAt: iso(),
                updatedAt: iso(),
              })
              .run(),
        ),
      findById: (id) => {
        const r = db.select().from(accounts).where(eq(accounts.id, id)).get()
        return r && toAccount(r)
      },
      listForSpace: (spaceId, opts) =>
        db
          .select()
          .from(accounts)
          .where(
            and(
              eq(accounts.primarySpaceId, spaceId),
              opts?.includeArchived ? undefined : isNull(accounts.archivedAt),
            ),
          )
          .orderBy(asc(accounts.name), asc(accounts.id))
          .all()
          .map(toAccount),
      update: (id, patch) =>
        void db
          .update(accounts)
          .set({ ...patch, updatedAt: iso() })
          .where(eq(accounts.id, id))
          .run(),
      findByExternal: (connectionId, externalId) => {
        const r = db
          .select()
          .from(accounts)
          .where(and(eq(accounts.connectionId, connectionId), eq(accounts.externalId, externalId)))
          .get()
        return r && toAccount(r)
      },
      listForConnection: (connectionId) =>
        db
          .select()
          .from(accounts)
          .where(eq(accounts.connectionId, connectionId))
          .orderBy(asc(accounts.name), asc(accounts.id))
          .all()
          .map(toAccount),
    },

    balances: {
      upsert(s) {
        const existing = db
          .select({ id: balanceSnapshots.id })
          .from(balanceSnapshots)
          .where(
            and(eq(balanceSnapshots.accountId, s.accountId), eq(balanceSnapshots.date, s.date)),
          )
          .get()
        mapWrite(() => {
          if (existing) {
            db.update(balanceSnapshots)
              .set({
                balanceCents: s.balanceCents,
                availableCents: s.availableCents ?? null,
                source: s.source,
              })
              .where(eq(balanceSnapshots.id, existing.id))
              .run()
          } else {
            db.insert(balanceSnapshots)
              .values({
                id: s.id,
                accountId: s.accountId,
                date: s.date,
                balanceCents: s.balanceCents,
                availableCents: s.availableCents ?? null,
                source: s.source,
                createdAt: iso(),
              })
              .run()
          }
        })
      },
      listForAccount: (accountId, opts) =>
        db
          .select()
          .from(balanceSnapshots)
          .where(eq(balanceSnapshots.accountId, accountId))
          .orderBy(desc(balanceSnapshots.date))
          .limit(opts?.limit ?? 1000)
          .all()
          .map((r) => ({
            id: r.id,
            accountId: r.accountId,
            date: r.date,
            balanceCents: r.balanceCents,
            availableCents: r.availableCents,
            source: r.source,
          })),
      latestForAccounts(ids) {
        const out = []
        for (const accountId of ids) {
          const r = db
            .select()
            .from(balanceSnapshots)
            .where(eq(balanceSnapshots.accountId, accountId))
            .orderBy(desc(balanceSnapshots.date))
            .limit(1)
            .get()
          if (r) {
            out.push({
              id: r.id,
              accountId: r.accountId,
              date: r.date,
              balanceCents: r.balanceCents,
              availableCents: r.availableCents,
              source: r.source,
            })
          }
        }
        return out
      },
    },

    categories: {
      create: (c) =>
        mapWrite(
          () =>
            void db
              .insert(categories)
              .values({
                id: c.id,
                spaceId: c.spaceId,
                name: c.name,
                kind: c.kind,
                parentId: c.parentId ?? null,
                taxLine: c.taxLine ?? null,
                sortOrder: c.sortOrder ?? 0,
                createdAt: iso(),
                updatedAt: iso(),
              })
              .run(),
        ),
      findById: (id) => {
        const r = db.select().from(categories).where(eq(categories.id, id)).get()
        return r && toCategory(r)
      },
      listForSpace: (spaceId, opts) =>
        db
          .select()
          .from(categories)
          .where(
            and(
              eq(categories.spaceId, spaceId),
              opts?.includeArchived ? undefined : isNull(categories.archivedAt),
            ),
          )
          .orderBy(
            sql`case ${categories.kind} when 'income' then 0 when 'expense' then 1 else 2 end`,
            asc(categories.sortOrder),
            asc(categories.name),
          )
          .all()
          .map(toCategory),
      update: (id, patch) =>
        void db
          .update(categories)
          .set({ ...patch, updatedAt: iso() })
          .where(eq(categories.id, id))
          .run(),
    },

    transactions: {
      create: (t, list) =>
        mapWrite(() =>
          handle.sqlite.transaction(() => {
            assertBalanced(t.amountCents, list)
            db.insert(transactions)
              .values({
                id: t.id,
                accountId: t.accountId,
                externalId: t.externalId ?? null,
                source: t.source,
                date: t.date,
                postedAt: t.postedAt ?? null,
                transactedAt: t.transactedAt ?? null,
                amountCents: t.amountCents,
                descriptionRaw: t.descriptionRaw,
                payee: t.payee ?? null,
                memo: t.memo ?? null,
                pending: t.pending ?? false,
                private: t.private ?? false,
                needsReview: t.needsReview ?? false,
                userEdited: t.userEdited ?? false,
                importBatchId: t.importBatchId ?? null,
                createdAt: iso(),
                updatedAt: iso(),
              })
              .run()
            insertSplits(t.id, list)
          })(),
        ),
      findById(id) {
        const r = db
          .select({ t: transactions, a: accounts })
          .from(transactions)
          .innerJoin(accounts, eq(accounts.id, transactions.accountId))
          .where(eq(transactions.id, id))
          .get()
        if (!r) return undefined
        return {
          txn: toTxn(r.t),
          splits: splitsOf(id),
          account: {
            id: r.a.id,
            name: r.a.name,
            primarySpaceId: r.a.primarySpaceId,
            currency: r.a.currency,
          },
        }
      },
      update: (id, patch, newSplits) =>
        mapWrite(() =>
          handle.sqlite.transaction(() => {
            const current = db.select().from(transactions).where(eq(transactions.id, id)).get()
            if (!current) return
            const finalAmount = patch.amountCents ?? current.amountCents
            if (newSplits) assertBalanced(finalAmount, newSplits)
            else if (patch.amountCents !== undefined) assertBalanced(finalAmount, splitsOf(id))
            db.update(transactions)
              .set({ ...patch, updatedAt: iso() })
              .where(eq(transactions.id, id))
              .run()
            if (newSplits) {
              db.delete(splitsTable).where(eq(splitsTable.transactionId, id)).run()
              insertSplits(id, newSplits)
            }
          })(),
        ),
      listForSpace(spaceId, f, page) {
        const like = (col: unknown, p: string) =>
          sql`lower(coalesce(${col}, '')) like ${p} escape '\\'`
        const pattern = f.q
          ? `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
          : undefined
        const where = and(
          eq(transactions.status, 'active'),
          or(
            eq(accounts.primarySpaceId, spaceId),
            exists(
              db
                .select({ x: sql`1` })
                .from(splitsTable)
                .where(
                  and(
                    eq(splitsTable.transactionId, transactions.id),
                    eq(splitsTable.spaceId, spaceId),
                  ),
                ),
            ),
          ),
          f.accountId ? eq(transactions.accountId, f.accountId) : undefined,
          f.categoryId
            ? exists(
                db
                  .select({ x: sql`1` })
                  .from(splitsTable)
                  .where(
                    and(
                      eq(splitsTable.transactionId, transactions.id),
                      eq(splitsTable.categoryId, f.categoryId),
                    ),
                  ),
              )
            : undefined,
          f.from ? gte(transactions.date, f.from) : undefined,
          f.to ? lte(transactions.date, f.to) : undefined,
          pattern
            ? or(
                like(transactions.descriptionRaw, pattern),
                like(transactions.payee, pattern),
                like(transactions.memo, pattern),
              )
            : undefined,
        )
        const total =
          db
            .select({ n: count() })
            .from(transactions)
            .innerJoin(accounts, eq(accounts.id, transactions.accountId))
            .where(where)
            .get()?.n ?? 0
        const rows = db
          .select({ t: transactions, a: accounts })
          .from(transactions)
          .innerJoin(accounts, eq(accounts.id, transactions.accountId))
          .where(where)
          .orderBy(desc(transactions.date), desc(transactions.id))
          .limit(page.limit)
          .offset(page.offset)
          .all()
        const ids = rows.map((r) => r.t.id)
        const byTxn = new Map<string, SplitRecord[]>()
        if (ids.length) {
          for (const sp of db
            .select()
            .from(splitsTable)
            .where(inArray(splitsTable.transactionId, ids))
            .orderBy(asc(splitsTable.id))
            .all()) {
            const list = byTxn.get(sp.transactionId) ?? []
            list.push(toSplit(sp))
            byTxn.set(sp.transactionId, list)
          }
        }
        return {
          total,
          rows: rows.map((r): TransactionWithSplits => ({
            txn: toTxn(r.t),
            splits: byTxn.get(r.t.id) ?? [],
            account: {
              id: r.a.id,
              name: r.a.name,
              primarySpaceId: r.a.primarySpaceId,
              currency: r.a.currency,
            },
          })),
        }
      },
      findByExternalId(accountId, externalId) {
        const r = db
          .select({ t: transactions, a: accounts })
          .from(transactions)
          .innerJoin(accounts, eq(accounts.id, transactions.accountId))
          .where(
            and(eq(transactions.accountId, accountId), eq(transactions.externalId, externalId)),
          )
          .get()
        if (!r) return undefined
        return {
          txn: toTxn(r.t),
          splits: splitsOf(r.t.id),
          account: {
            id: r.a.id,
            name: r.a.name,
            primarySpaceId: r.a.primarySpaceId,
            currency: r.a.currency,
          },
        }
      },
      listForAccountSince(accountId, fromDate) {
        const rows = db
          .select({ t: transactions, a: accounts })
          .from(transactions)
          .innerJoin(accounts, eq(accounts.id, transactions.accountId))
          .where(and(eq(transactions.accountId, accountId), gte(transactions.date, fromDate)))
          .orderBy(desc(transactions.date), desc(transactions.id))
          .all()
        return rows.map((r) => ({
          txn: toTxn(r.t),
          splits: splitsOf(r.t.id),
          account: {
            id: r.a.id,
            name: r.a.name,
            primarySpaceId: r.a.primarySpaceId,
            currency: r.a.currency,
          },
        }))
      },
      countForAccount: (accountId) =>
        db
          .select({ n: count() })
          .from(transactions)
          .where(eq(transactions.accountId, accountId))
          .get()?.n ?? 0,
      findOppositeCandidates(q) {
        const rows = db
          .select({ t: transactions, a: accounts })
          .from(transactions)
          .innerJoin(accounts, eq(accounts.id, transactions.accountId))
          .where(
            and(
              eq(transactions.status, 'active'),
              eq(transactions.amountCents, q.amountCents),
              ne(transactions.accountId, q.excludeAccountId),
              eq(accounts.currency, q.currency),
              gte(transactions.date, q.from),
              lte(transactions.date, q.to),
              sql`not exists (select 1 from transfer_links l where l.from_transaction_id = ${transactions.id} or l.to_transaction_id = ${transactions.id})`,
            ),
          )
          .orderBy(asc(transactions.date), asc(transactions.id))
          .all()
        return rows.map((r) => ({
          txn: toTxn(r.t),
          splits: splitsOf(r.t.id),
          account: {
            id: r.a.id,
            name: r.a.name,
            primarySpaceId: r.a.primarySpaceId,
            currency: r.a.currency,
          },
        }))
      },
      findInvariantViolations() {
        const rows = db
          .select({
            id: transactions.id,
            amount: transactions.amountCents,
            splitTotal: sql<number>`coalesce(sum(${splitsTable.amountCents}), 0)`,
            n: count(splitsTable.id),
          })
          .from(transactions)
          .leftJoin(splitsTable, eq(splitsTable.transactionId, transactions.id))
          .where(eq(transactions.status, 'active'))
          .groupBy(transactions.id)
          .all()
        return rows.filter((r) => r.n === 0 || r.splitTotal !== r.amount).map((r) => r.id)
      },
    },

    transfers: {
      create: (l) =>
        mapWrite(
          () =>
            void db
              .insert(transferLinks)
              .values({ ...l, createdAt: iso() })
              .run(),
        ),
      findByTransaction(transactionId) {
        const r = db
          .select()
          .from(transferLinks)
          .where(
            or(
              eq(transferLinks.fromTransactionId, transactionId),
              eq(transferLinks.toTransactionId, transactionId),
            ),
          )
          .get()
        return (
          r && {
            id: r.id,
            fromTransactionId: r.fromTransactionId,
            toTransactionId: r.toTransactionId,
            createdBy: r.createdBy,
          }
        )
      },
      delete: (id) => void db.delete(transferLinks).where(eq(transferLinks.id, id)).run(),
    },

    pads: {
      installs: {
        get: (padId) => {
          const r = db.select().from(lilypadInstalls).where(eq(lilypadInstalls.padId, padId)).get()
          return r && { ...r, permissionsGranted: r.permissionsGranted as string[] }
        },
        list: () =>
          db
            .select()
            .from(lilypadInstalls)
            .orderBy(asc(lilypadInstalls.padId))
            .all()
            .map((r) => ({ ...r, permissionsGranted: r.permissionsGranted as string[] })),
        upsert: (rec) =>
          mapWrite(
            () =>
              void db
                .insert(lilypadInstalls)
                .values(rec)
                .onConflictDoUpdate({ target: lilypadInstalls.padId, set: { ...rec } })
                .run(),
          ),
        delete: (padId) =>
          void db.delete(lilypadInstalls).where(eq(lilypadInstalls.padId, padId)).run(),
      },
      enablement: {
        isEnabled: (padId, spaceId) =>
          !!db
            .select({ p: lilypadSpaceEnablement.padId })
            .from(lilypadSpaceEnablement)
            .where(
              and(
                eq(lilypadSpaceEnablement.padId, padId),
                eq(lilypadSpaceEnablement.spaceId, spaceId),
              ),
            )
            .get(),
        padsForSpace: (spaceId) =>
          db
            .select({ p: lilypadSpaceEnablement.padId })
            .from(lilypadSpaceEnablement)
            .where(eq(lilypadSpaceEnablement.spaceId, spaceId))
            .orderBy(asc(lilypadSpaceEnablement.padId))
            .all()
            .map((r) => r.p),
        spacesForPad: (padId) =>
          db
            .select({ s: lilypadSpaceEnablement.spaceId })
            .from(lilypadSpaceEnablement)
            .where(eq(lilypadSpaceEnablement.padId, padId))
            .orderBy(asc(lilypadSpaceEnablement.spaceId))
            .all()
            .map((r) => r.s),
        enable: (padId, spaceId, by, at) =>
          mapWrite(
            () =>
              void db
                .insert(lilypadSpaceEnablement)
                .values({ padId, spaceId, enabledBy: by, enabledAt: at })
                .onConflictDoNothing()
                .run(),
          ),
        disable: (padId, spaceId) =>
          void db
            .delete(lilypadSpaceEnablement)
            .where(
              and(
                eq(lilypadSpaceEnablement.padId, padId),
                eq(lilypadSpaceEnablement.spaceId, spaceId),
              ),
            )
            .run(),
        removeAllForPad: (padId) =>
          void db
            .delete(lilypadSpaceEnablement)
            .where(eq(lilypadSpaceEnablement.padId, padId))
            .run(),
      },
      migrations: {
        applied: (padId) =>
          db
            .select({ n: lilypadMigrations.name })
            .from(lilypadMigrations)
            .where(eq(lilypadMigrations.padId, padId))
            .orderBy(asc(lilypadMigrations.appliedAt), asc(lilypadMigrations.name))
            .all()
            .map((r) => r.n),
        record: (padId, name, at) =>
          void db.insert(lilypadMigrations).values({ padId, name, appliedAt: at }).run(),
        removeAllForPad: (padId) =>
          void db.delete(lilypadMigrations).where(eq(lilypadMigrations.padId, padId)).run(),
      },
      jobRuns: {
        get: (padId, job, spaceId) =>
          db
            .select({ at: lilypadJobRuns.lastRunAt })
            .from(lilypadJobRuns)
            .where(
              and(
                eq(lilypadJobRuns.padId, padId),
                eq(lilypadJobRuns.jobName, job),
                eq(lilypadJobRuns.spaceId, spaceId),
              ),
            )
            .get()?.at,
        set: (padId, job, spaceId, at) =>
          void db
            .insert(lilypadJobRuns)
            .values({ padId, jobName: job, spaceId, lastRunAt: at })
            .onConflictDoUpdate({
              target: [lilypadJobRuns.padId, lilypadJobRuns.jobName, lilypadJobRuns.spaceId],
              set: { lastRunAt: at },
            })
            .run(),
        removeAllForPad: (padId) =>
          void db.delete(lilypadJobRuns).where(eq(lilypadJobRuns.padId, padId)).run(),
      },
    },

    settings: {
      get: (scope, scopeId, key) =>
        db
          .select({ v: settings.value })
          .from(settings)
          .where(
            and(eq(settings.scope, scope), eq(settings.scopeId, scopeId), eq(settings.key, key)),
          )
          .get()?.v,
      set: (scope, scopeId, key, value) =>
        void db
          .insert(settings)
          .values({
            scope,
            scopeId,
            key,
            value: value as never,
            createdAt: iso(),
            updatedAt: iso(),
          })
          .onConflictDoUpdate({
            target: [settings.scope, settings.scopeId, settings.key],
            set: { value: value as never, updatedAt: iso() },
          })
          .run(),
      deleteByPrefix: (prefix) =>
        void handle.sqlite
          .prepare('DELETE FROM settings WHERE substr(key, 1, ?) = ?')
          .run(prefix.length, prefix),
    },

    reports: {
      sumSplits(spaceId, o) {
        const excluded = o.excludeKinds ?? ['transfer']
        const by = o.groupBy
        const select = [
          by !== 'month'
            ? 's.category_id AS categoryId, c.kind AS kind'
            : 'NULL AS categoryId, NULL AS kind',
          by !== 'category' ? 'substr(t.date, 1, 7) AS month' : 'NULL AS month',
          'sum(s.amount_cents) AS cents',
          'sum(CASE WHEN s.amount_cents > 0 THEN s.amount_cents ELSE 0 END) AS inCents',
          'count(*) AS count',
        ].join(', ')
        const group = [
          by !== 'month' ? 's.category_id' : '',
          by !== 'category' ? 'substr(t.date, 1, 7)' : '',
        ]
          .filter(Boolean)
          .join(', ')
        const params: (string | number)[] = [spaceId, o.from, o.to]
        let where =
          "s.space_id = ? AND t.status = 'active' AND t.date >= ? AND t.date <= ? AND NOT EXISTS (SELECT 1 FROM transfer_links l WHERE l.from_transaction_id = t.id OR l.to_transaction_id = t.id)"
        if (excluded.length) {
          where += ` AND (c.kind IS NULL OR c.kind NOT IN (${excluded.map(() => '?').join(', ')}))`
          params.push(...excluded)
        }
        if (o.categoryIds?.length) {
          where += ` AND s.category_id IN (${o.categoryIds.map(() => '?').join(', ')})`
          params.push(...o.categoryIds)
        }
        const sqlText = `SELECT ${select} FROM splits s JOIN transactions t ON t.id = s.transaction_id JOIN accounts a ON a.id = t.account_id JOIN spaces sp ON sp.id = s.space_id AND sp.currency = a.currency LEFT JOIN categories c ON c.id = s.category_id WHERE ${where} GROUP BY ${group} ORDER BY ${group}`
        return (handle.sqlite.prepare(sqlText).all(...params) as SplitSumRow[]).map((r) => ({
          ...r,
        }))
      },
    },

    padStore: createSqlitePadStore(handle.sqlite, { newId, now }),

    system: { schemaVersion: () => schemaVersion(handle) },
    transaction: (fn) => handle.sqlite.transaction(fn)(),
  }
}
