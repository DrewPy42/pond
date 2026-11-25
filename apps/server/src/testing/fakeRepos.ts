import { createMemoryPadStore } from '@pond/sdk/testing'
import type { SplitSumRow } from '@pond/sdk'
import { checkSplits } from '../ledger/splits.js'
import {
  DuplicateError,
  MissingParentError,
  SplitInvariantError,
  type AccountRecord,
  type BalanceSnapshotRecord,
  type CategoryRecord,
  type ConnectionRecord,
  type ImportBatchRecord,
  type PadInstallRecord,
  type RuleRecord,
  type NewSplit,
  type SplitRecord,
  type TransactionRecord,
  type TransactionWithSplits,
  type TransferLinkRecord,
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
  const connections = new Map<string, ConnectionRecord>()
  const ruleRows = new Map<string, RuleRecord>()
  const batches = new Map<string, ImportBatchRecord>()
  const padInstalls = new Map<string, PadInstallRecord>()
  const padEnabled = new Map<string, { padId: string; spaceId: string; by: string; at: string }>()
  const padMigrations: { padId: string; name: string; at: string }[] = []
  const padJobRuns = new Map<string, string>()
  const settingRows = new Map<string, unknown>()
  let padIdCounter = 0
  const padStore = createMemoryPadStore({ newId: () => `pad-row-${++padIdCounter}`, now })
  const accounts = new Map<string, AccountRecord>()
  const balances = new Map<string, BalanceSnapshotRecord>()
  const categories = new Map<string, CategoryRecord>()
  const txns = new Map<string, TransactionRecord>()
  const splitRows = new Map<string, SplitRecord>()
  const links = new Map<string, TransferLinkRecord>()
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

  const accountSummary = (a: AccountRecord) => ({
    id: a.id,
    name: a.name,
    primarySpaceId: a.primarySpaceId,
    currency: a.currency,
  })
  const splitsOf = (txnId: string): SplitRecord[] =>
    [...splitRows.values()]
      .filter((x) => x.transactionId === txnId)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
  const assertBalanced = (amount: number, list: readonly { amountCents: number }[]) => {
    const problem = checkSplits(amount, list)
    if (problem) throw new SplitInvariantError(problem)
  }
  const checkSplitParents = (list: NewSplit[]) => {
    for (const sp of list) {
      if (!spaces.has(sp.spaceId)) throw new MissingParentError('unknown space')
      if (sp.categoryId && !categories.has(sp.categoryId))
        throw new MissingParentError('unknown category')
    }
  }
  const putSplits = (txnId: string, list: NewSplit[]) => {
    for (const sp of list) {
      splitRows.set(sp.id, {
        id: sp.id,
        transactionId: txnId,
        spaceId: sp.spaceId,
        categoryId: sp.categoryId ?? null,
        amountCents: sp.amountCents,
        memo: sp.memo ?? null,
        reimbursable: sp.reimbursable ?? false,
        reimbursedAt: null,
      })
    }
  }
  const withSplits = (t: TransactionRecord): TransactionWithSplits => ({
    txn: t,
    splits: splitsOf(t.id),
    account: accountSummary(accounts.get(t.accountId)!),
  })

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
      deleteAll: () => sessions.clear(),
      deleteForUser(userId, exceptId) {
        for (const [id, s] of sessions)
          if (s.userId === userId && id !== exceptId) sessions.delete(id)
      },
    },

    spaces: {
      contents: (spaceId) => ({
        accounts: [...accounts.values()].filter((a) => a.primarySpaceId === spaceId).length,
        splits: [...splitRows.values()].filter((s) => s.spaceId === spaceId).length,
        appRows: padStore.countSpaceRows(spaceId),
      }),
      delete(spaceId) {
        // The real database refuses (foreign keys) to remove a Space something still points at.
        if (
          [...accounts.values()].some((a) => a.primarySpaceId === spaceId) ||
          [...splitRows.values()].some((s) => s.spaceId === spaceId)
        )
          throw new MissingParentError('the Space is still in use')
        for (const [k, v] of padEnabled) if (v.spaceId === spaceId) padEnabled.delete(k)
        for (const k of padJobRuns.keys()) if (k.endsWith(`|${spaceId}`)) padJobRuns.delete(k)
        for (const k of settingRows.keys())
          if (k.startsWith(`space|${spaceId}|`)) settingRows.delete(k)
        for (const [k, v] of ruleRows) if (v.spaceId === spaceId) ruleRows.delete(k)
        for (const [k, v] of categories) if (v.spaceId === spaceId) categories.delete(k)
        for (const k of members.keys()) if (k.startsWith(`${spaceId}|`)) members.delete(k)
        spaces.delete(spaceId)
      },
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

    rules: {
      create(r) {
        if (!spaces.has(r.spaceId) || !users.has(r.createdBy))
          throw new MissingParentError('unknown space or user')
        ruleRows.set(r.id, { ...r })
      },
      findById: (id) => ruleRows.get(id),
      listForSpace: (spaceId) =>
        [...ruleRows.values()]
          .filter((r) => r.spaceId === spaceId)
          .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1)),
      update(id, patch) {
        const r = ruleRows.get(id)
        if (r) ruleRows.set(id, { ...r, ...patch })
      },
      delete: (id) => void ruleRows.delete(id),
    },

    importBatches: {
      create(b) {
        if (!accounts.has(b.accountId) || !users.has(b.createdBy))
          throw new MissingParentError('unknown account or user')
        batches.set(b.id, { ...b, createdAt: iso() })
      },
      findById: (id) => batches.get(id),
      listForAccounts: (accountIds, opts) =>
        [...batches.values()]
          .filter((b) => accountIds.includes(b.accountId))
          .sort((a, b) =>
            a.createdAt === b.createdAt
              ? a.id < b.id
                ? 1
                : -1
              : a.createdAt < b.createdAt
                ? 1
                : -1,
          )
          .slice(0, opts?.limit ?? 50),
    },

    connections: {
      create(c) {
        if (!users.has(c.createdBy)) throw new MissingParentError('unknown user')
        connections.set(c.id, { ...c, status: 'active', lastSyncedAt: null, lastError: null })
      },
      findById: (id) => connections.get(id),
      list: () =>
        [...connections.values()].sort(
          (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
        ),
      update(id, patch) {
        const c = connections.get(id)
        if (c) connections.set(id, { ...c, ...patch })
      },
    },

    accounts: {
      create(a) {
        if (a.primarySpaceId && !spaces.has(a.primarySpaceId))
          throw new MissingParentError('unknown space')
        if (a.connectionId && !connections.has(a.connectionId)) {
          throw new MissingParentError('unknown connection')
        }
        if (
          a.connectionId &&
          a.externalId &&
          [...accounts.values()].some(
            (x) => x.connectionId === a.connectionId && x.externalId === a.externalId,
          )
        ) {
          throw new DuplicateError('account already synced')
        }
        accounts.set(a.id, {
          id: a.id,
          connectionId: a.connectionId ?? null,
          externalId: a.externalId ?? null,
          institutionName: a.institutionName ?? null,
          name: a.name,
          nickname: a.nickname ?? null,
          type: a.type,
          currency: a.currency,
          primarySpaceId: a.primarySpaceId ?? null,
          isManual: a.isManual ?? true,
          includeInNetWorth: a.includeInNetWorth ?? true,
          syncEnabled: a.syncEnabled ?? false,
          hidden: a.hidden ?? false,
          lastFour: a.lastFour ?? null,
          archivedAt: null,
        })
      },
      findById: (id) => accounts.get(id),
      listForSpace: (spaceId, opts) =>
        [...accounts.values()]
          .filter(
            (a) => a.primarySpaceId === spaceId && (opts?.includeArchived || a.archivedAt === null),
          )
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      update(id, patch) {
        const a = accounts.get(id)
        if (a) accounts.set(id, { ...a, ...patch })
      },
      findByExternal: (connectionId, externalId) =>
        [...accounts.values()].find(
          (a) => a.connectionId === connectionId && a.externalId === externalId,
        ),
      listForConnection: (connectionId) =>
        [...accounts.values()]
          .filter((a) => a.connectionId === connectionId)
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    },

    balances: {
      upsert(snap) {
        if (!accounts.has(snap.accountId)) throw new MissingParentError('unknown account')
        const existing = [...balances.values()].find(
          (b) => b.accountId === snap.accountId && b.date === snap.date,
        )
        const next = { ...snap, availableCents: snap.availableCents ?? null }
        if (existing) balances.set(existing.id, { ...existing, ...next, id: existing.id })
        else balances.set(snap.id, next)
      },
      listForAccount: (accountId, opts) =>
        [...balances.values()]
          .filter((b) => b.accountId === accountId)
          .sort((a, b) => (a.date < b.date ? 1 : -1))
          .slice(0, opts?.limit ?? 1000),
      latestForAccounts: (ids) =>
        ids.flatMap((id) => {
          const latest = [...balances.values()]
            .filter((b) => b.accountId === id)
            .sort((a, b) => (a.date < b.date ? 1 : -1))[0]
          return latest ? [latest] : []
        }),
    },

    categories: {
      create(c) {
        if (!spaces.has(c.spaceId)) throw new MissingParentError('unknown space')
        categories.set(c.id, {
          id: c.id,
          spaceId: c.spaceId,
          parentId: c.parentId ?? null,
          name: c.name,
          kind: c.kind,
          taxLine: c.taxLine ?? null,
          sortOrder: c.sortOrder ?? 0,
          archivedAt: null,
        })
      },
      findById: (id) => categories.get(id),
      listForSpace(spaceId, opts) {
        const rank = { income: 0, expense: 1, transfer: 2 } as const
        return [...categories.values()]
          .filter((c) => c.spaceId === spaceId && (opts?.includeArchived || c.archivedAt === null))
          .sort(
            (a, b) =>
              rank[a.kind] - rank[b.kind] ||
              a.sortOrder - b.sortOrder ||
              a.name.localeCompare(b.name),
          )
      },
      update(id, patch) {
        const c = categories.get(id)
        if (c) categories.set(id, { ...c, ...patch })
      },
    },

    transactions: {
      create(t, list) {
        assertBalanced(t.amountCents, list)
        if (!accounts.has(t.accountId)) throw new MissingParentError('unknown account')
        checkSplitParents(list)
        if (
          t.externalId &&
          [...txns.values()].some(
            (x) => x.accountId === t.accountId && x.externalId === t.externalId,
          )
        ) {
          throw new DuplicateError('duplicate external id')
        }
        txns.set(t.id, {
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
          status: 'active',
          private: t.private ?? false,
          needsReview: t.needsReview ?? false,
          userEdited: t.userEdited ?? false,
          supersededBy: null,
          importBatchId: t.importBatchId ?? null,
        })
        putSplits(t.id, list)
      },
      findById(id) {
        const t = txns.get(id)
        return t && withSplits(t)
      },
      update(id, patch, newSplits) {
        const t = txns.get(id)
        if (!t) return
        const finalAmount = patch.amountCents ?? t.amountCents
        if (newSplits) {
          assertBalanced(finalAmount, newSplits)
          checkSplitParents(newSplits)
        } else if (patch.amountCents !== undefined) {
          assertBalanced(finalAmount, splitsOf(id))
        }
        txns.set(id, { ...t, ...patch })
        if (newSplits) {
          for (const sp of splitsOf(id)) splitRows.delete(sp.id)
          putSplits(id, newSplits)
        }
      },
      listForSpace(spaceId, f, page) {
        const q = f.q?.toLowerCase()
        const matches = [...txns.values()]
          .filter((t) => {
            if (t.status !== 'active') return false
            const acct = accounts.get(t.accountId)!
            const sp = splitsOf(t.id)
            if (acct.primarySpaceId !== spaceId && !sp.some((x) => x.spaceId === spaceId))
              return false
            if (f.accountId && t.accountId !== f.accountId) return false
            if (f.categoryId && !sp.some((x) => x.categoryId === f.categoryId)) return false
            if (f.from && t.date < f.from) return false
            if (f.to && t.date > f.to) return false
            if (q) {
              const hay = [t.descriptionRaw, t.payee ?? '', t.memo ?? ''].map((x) =>
                x.toLowerCase(),
              )
              if (!hay.some((x) => x.includes(q))) return false
            }
            return true
          })
          .sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1))
        return {
          total: matches.length,
          rows: matches.slice(page.offset, page.offset + page.limit).map(withSplits),
        }
      },
      findByExternalId(accountId, externalId) {
        const t = [...txns.values()].find(
          (x) => x.accountId === accountId && x.externalId === externalId,
        )
        return t && withSplits(t)
      },
      listForAccountSince: (accountId, fromDate) =>
        [...txns.values()]
          .filter((t) => t.accountId === accountId && t.date >= fromDate)
          .sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1))
          .map(withSplits),
      countForAccount: (accountId) =>
        [...txns.values()].filter((t) => t.accountId === accountId).length,
      findOppositeCandidates: (q) =>
        [...txns.values()]
          .filter((t) => {
            const acct = accounts.get(t.accountId)!
            const linked = [...links.values()].some(
              (l) => l.fromTransactionId === t.id || l.toTransactionId === t.id,
            )
            return (
              t.status === 'active' &&
              t.amountCents === q.amountCents &&
              t.accountId !== q.excludeAccountId &&
              acct.currency === q.currency &&
              t.date >= q.from &&
              t.date <= q.to &&
              !linked
            )
          })
          .sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1))
          .map(withSplits),
      findInvariantViolations: () =>
        [...txns.values()]
          .filter(
            (t) => t.status === 'active' && checkSplits(t.amountCents, splitsOf(t.id)) !== null,
          )
          .map((t) => t.id),
    },

    transfers: {
      create(l) {
        if (!txns.has(l.fromTransactionId) || !txns.has(l.toTransactionId)) {
          throw new MissingParentError('unknown transaction')
        }
        // Same rule as the database's two unique indexes: a transaction can be the "from" side
        // of one link and the "to" side of one link.
        for (const x of links.values()) {
          if (
            x.fromTransactionId === l.fromTransactionId ||
            x.toTransactionId === l.toTransactionId
          ) {
            throw new DuplicateError('already linked')
          }
        }
        links.set(l.id, { ...l })
      },
      findByTransaction: (id) =>
        [...links.values()].find((l) => l.fromTransactionId === id || l.toTransactionId === id),
      delete: (id) => void links.delete(id),
    },

    pads: {
      installs: {
        get: (padId) => padInstalls.get(padId),
        list: () => [...padInstalls.values()].sort((a, b) => a.padId.localeCompare(b.padId)),
        upsert(rec) {
          if (!users.has(rec.installedBy)) throw new MissingParentError('unknown user')
          padInstalls.set(rec.padId, { ...rec })
        },
        delete: (padId) => void padInstalls.delete(padId),
      },
      enablement: {
        isEnabled: (padId, spaceId) => padEnabled.has(`${padId}|${spaceId}`),
        padsForSpace: (spaceId) =>
          [...padEnabled.values()]
            .filter((e) => e.spaceId === spaceId)
            .map((e) => e.padId)
            .sort(),
        spacesForPad: (padId) =>
          [...padEnabled.values()]
            .filter((e) => e.padId === padId)
            .map((e) => e.spaceId)
            .sort(),
        enable(padId, spaceId, by, at) {
          if (!spaces.has(spaceId) || !users.has(by))
            throw new MissingParentError('unknown space or user')
          if (!padEnabled.has(`${padId}|${spaceId}`))
            padEnabled.set(`${padId}|${spaceId}`, { padId, spaceId, by, at })
        },
        disable: (padId, spaceId) => void padEnabled.delete(`${padId}|${spaceId}`),
        removeAllForPad(padId) {
          for (const [k, e] of padEnabled) if (e.padId === padId) padEnabled.delete(k)
        },
      },
      migrations: {
        applied: (padId) => padMigrations.filter((m) => m.padId === padId).map((m) => m.name),
        record(padId, name, at) {
          if (padMigrations.some((m) => m.padId === padId && m.name === name))
            throw new DuplicateError('already applied')
          padMigrations.push({ padId, name, at })
        },
        removeAllForPad(padId) {
          for (let i = padMigrations.length - 1; i >= 0; i--)
            if (padMigrations[i]!.padId === padId) padMigrations.splice(i, 1)
        },
      },
      jobRuns: {
        get: (padId, job, spaceId) => padJobRuns.get(`${padId}|${job}|${spaceId}`),
        set: (padId, job, spaceId, at) => void padJobRuns.set(`${padId}|${job}|${spaceId}`, at),
        removeAllForPad(padId) {
          for (const k of padJobRuns.keys()) if (k.startsWith(`${padId}|`)) padJobRuns.delete(k)
        },
      },
    },

    settings: {
      get: (scope, scopeId, key) => settingRows.get(`${scope}|${scopeId}|${key}`),
      set: (scope, scopeId, key, value) =>
        void settingRows.set(`${scope}|${scopeId}|${key}`, structuredClone(value)),
      deleteByPrefix(prefix) {
        for (const k of settingRows.keys())
          if (k.split('|').slice(2).join('|').startsWith(prefix)) settingRows.delete(k)
      },
    },

    reports: {
      sumSplits(spaceId, o) {
        const excluded = o.excludeKinds ?? ['transfer']
        const groups = new Map<string, SplitSumRow>()
        for (const sp of splitRows.values()) {
          if (sp.spaceId !== spaceId) continue
          const t = txns.get(sp.transactionId)!
          if (t.status !== 'active' || t.date < o.from || t.date > o.to) continue
          if (
            [...links.values()].some(
              (l) => l.fromTransactionId === t.id || l.toTransactionId === t.id,
            )
          )
            continue
          // Different currencies are never added together.
          if (accounts.get(t.accountId)!.currency !== spaces.get(spaceId)?.currency) continue
          const cat = sp.categoryId ? categories.get(sp.categoryId) : undefined
          if (cat && excluded.includes(cat.kind)) continue
          if (o.categoryIds?.length && !(sp.categoryId && o.categoryIds.includes(sp.categoryId)))
            continue
          const categoryId = o.groupBy !== 'month' ? sp.categoryId : null
          const month = o.groupBy !== 'category' ? t.date.slice(0, 7) : null
          const key = `${categoryId}|${month}`
          const row = groups.get(key) ?? {
            categoryId,
            kind: categoryId ? (cat?.kind ?? null) : null,
            month,
            cents: 0,
            inCents: 0,
            count: 0,
          }
          row.inCents += Math.max(sp.amountCents, 0)
          row.cents += sp.amountCents
          row.count += 1
          groups.set(key, row)
        }
        const cmp = (a: string | null, b: string | null) =>
          a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1
        return [...groups.values()].sort(
          (a, b) => cmp(a.categoryId, b.categoryId) || cmp(a.month, b.month),
        )
      },
    },

    padStore,

    system: { schemaVersion: () => schemaVersion },
    transaction: (fn) => fn(),
  }
}
