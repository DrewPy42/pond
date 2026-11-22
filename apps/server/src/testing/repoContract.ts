import { describe, expect, it } from 'vitest'
import {
  DuplicateError,
  MissingParentError,
  SplitInvariantError,
  type AuditRecord,
  type Repos,
} from '../repos/types.js'
import {
  buildAccount,
  buildCategory,
  buildSpace,
  buildSplit,
  buildTransaction,
  buildUser,
} from './factories.js'

/**
 * The repository contract. It runs against the in-memory fakes AND the real Drizzle
 * repositories (see repos/*.contract.test.ts), so the fakes used by every other test are proven
 * to behave like the database. These are the only functionality-style tests that touch SQLite.
 */
export function repoContract(label: string, make: () => Repos): void {
  const audit = (over: Partial<AuditRecord> = {}): AuditRecord => ({
    id: 'a1',
    at: '2030-01-01T00:00:00.000Z',
    actorType: 'user',
    actorId: null,
    action: 'x',
    targetType: null,
    targetId: null,
    spaceId: null,
    meta: null,
    ...over,
  })

  describe(`${label}: UserRepo`, () => {
    /**
     * Function: users.create(user), users.findById(id), users.findByUsername(name)
     * Inputs:   one new user (username "ann", admin, no email)
     * Expected: found by id and by username with the same fields; status "active", TOTP unset
     */
    it('stores a user and finds it by id and by username', () => {
      const r = make()
      r.users.create(buildUser({ id: 'u1', username: 'ann', isAdmin: true }))
      for (const found of [r.users.findById('u1'), r.users.findByUsername('ann')]) {
        expect(found).toMatchObject({
          id: 'u1',
          username: 'ann',
          isAdmin: true,
          status: 'active',
          email: null,
          totpEnabledAt: null,
          totpSecretEnc: null,
        })
      }
      expect(r.users.findById('missing')).toBeUndefined()
    })

    /**
     * Function: users.create(user)
     * Inputs:   two users with the same username "ann"
     * Expected: the second call throws DuplicateError and only one user exists
     */
    it('refuses a duplicate username', () => {
      const r = make()
      r.users.create(buildUser({ id: 'u1', username: 'ann' }))
      expect(() => r.users.create(buildUser({ id: 'u2', username: 'ann' }))).toThrow(DuplicateError)
      expect(r.users.count()).toBe(1)
    })

    /**
     * Function: users.createIfNoUsers(user)
     * Inputs:   first call on an empty store, then a second user
     * Expected: true for the first (created), false for the second (not created)
     */
    it('creates the first user only once', () => {
      const r = make()
      expect(r.users.createIfNoUsers(buildUser({ id: 'u1', username: 'a1', isAdmin: true }))).toBe(
        true,
      )
      expect(r.users.createIfNoUsers(buildUser({ id: 'u2', username: 'b2' }))).toBe(false)
      expect(r.users.count()).toBe(1)
    })

    /**
     * Function: users.list()
     * Inputs:   users "carl", "ann", "bob" added in that order
     * Expected: listed alphabetically by username: ann, bob, carl
     */
    it('lists users ordered by username', () => {
      const r = make()
      for (const name of ['carl', 'ann', 'bob']) r.users.create(buildUser({ username: name }))
      expect(r.users.list().map((u) => u.username)).toEqual(['ann', 'bob', 'carl'])
    })

    /**
     * Function: users.update(id, patch)
     * Inputs:   patch { displayName: "Ann B", status: "disabled", email: "a@b.co" } for one user
     * Expected: those fields change, others (username, passwordHash) stay the same
     */
    it('updates only the fields in the patch', () => {
      const r = make()
      r.users.create(buildUser({ id: 'u1', username: 'ann', passwordHash: 'H' }))
      r.users.update('u1', { displayName: 'Ann B', status: 'disabled', email: 'a@b.co' })
      expect(r.users.findById('u1')).toMatchObject({
        username: 'ann',
        passwordHash: 'H',
        displayName: 'Ann B',
        status: 'disabled',
        email: 'a@b.co',
      })
    })

    /**
     * Function: users.countActiveAdminsExcept(exceptId)
     * Inputs:   admins "a" (active), "b" (disabled), "c" (active); non-admin "d"; except "a"
     * Expected: 1 (only "c" counts: disabled and non-admins are ignored, and "a" is excluded)
     */
    it('counts other active admins', () => {
      const r = make()
      r.users.create(buildUser({ id: 'a', username: 'aa1', isAdmin: true }))
      r.users.create(buildUser({ id: 'b', username: 'bb2', isAdmin: true }))
      r.users.create(buildUser({ id: 'c', username: 'cc3', isAdmin: true }))
      r.users.create(buildUser({ id: 'd', username: 'dd4' }))
      r.users.update('b', { status: 'disabled' })
      expect(r.users.countActiveAdminsExcept('a')).toBe(1)
    })
  })

  describe(`${label}: RecoveryCodeRepo`, () => {
    /**
     * Function: recoveryCodes.replaceForUser, findUnused, markUsed, countUnused
     * Inputs:   three code hashes for a user; then one is marked used; then the set is replaced
     * Expected: findUnused finds a code until it is used; countUnused falls from 3 to 2;
     *           replacing removes the old codes entirely
     */
    it('stores hashed codes, spends each once, and replaces the set', () => {
      const r = make()
      r.users.create(buildUser({ id: 'u1', username: 'ann' }))
      r.recoveryCodes.replaceForUser('u1', [
        { id: 'c1', codeHash: 'h1' },
        { id: 'c2', codeHash: 'h2' },
        { id: 'c3', codeHash: 'h3' },
      ])
      expect(r.recoveryCodes.countUnused('u1')).toBe(3)
      const found = r.recoveryCodes.findUnused('u1', 'h2')!
      expect(found.id).toBe('c2')
      r.recoveryCodes.markUsed('c2', '2030-01-01T00:00:00.000Z')
      expect(r.recoveryCodes.findUnused('u1', 'h2')).toBeUndefined()
      expect(r.recoveryCodes.countUnused('u1')).toBe(2)

      r.recoveryCodes.replaceForUser('u1', [{ id: 'c9', codeHash: 'h9' }])
      expect(r.recoveryCodes.findUnused('u1', 'h1')).toBeUndefined()
      expect(r.recoveryCodes.countUnused('u1')).toBe(1)
    })
  })

  describe(`${label}: SessionRepo`, () => {
    const base = (id: string, userId: string) => ({
      id,
      userId,
      csrfHash: 'c',
      expiresAt: '2030-01-01T12:00:00.000Z',
      absoluteExpiresAt: '2030-02-01T00:00:00.000Z',
      lastSeenAt: '2030-01-01T00:00:00.000Z',
      ip: '10.0.0.1',
      userAgent: 'test',
    })

    /**
     * Function: sessions.create, findWithUser, touch, setReauth
     * Inputs:   a session for user "u1"; then touch with new times; then setReauth
     * Expected: findWithUser returns the session and its user; touch changes lastSeenAt and
     *           expiresAt; setReauth records reauthAt (null before)
     */
    it('stores a session, returns it with its user, and records activity and re-auth', () => {
      const r = make()
      r.users.create(buildUser({ id: 'u1', username: 'ann' }))
      r.sessions.create(base('s1', 'u1'))
      const found = r.sessions.findWithUser('s1')!
      expect(found.user.username).toBe('ann')
      expect(found.session.reauthAt).toBeNull()

      r.sessions.touch('s1', '2030-01-01T06:00:00.000Z', '2030-01-01T18:00:00.000Z')
      r.sessions.setReauth('s1', '2030-01-01T06:01:00.000Z')
      expect(r.sessions.findWithUser('s1')!.session).toMatchObject({
        lastSeenAt: '2030-01-01T06:00:00.000Z',
        expiresAt: '2030-01-01T18:00:00.000Z',
        reauthAt: '2030-01-01T06:01:00.000Z',
      })
      expect(r.sessions.findWithUser('nope')).toBeUndefined()
    })

    /**
     * Function: sessions.create(session)
     * Inputs:   a session for a user id that does not exist
     * Expected: throws MissingParentError (the database enforces this with a foreign key)
     */
    it('refuses a session for an unknown user', () => {
      expect(() => make().sessions.create(base('s1', 'ghost'))).toThrow(MissingParentError)
    })

    /**
     * Function: sessions.delete(id), sessions.deleteForUser(userId, exceptId)
     * Inputs:   user "u1" with sessions s1, s2, s3 and user "u2" with s4
     * Expected: delete removes one; deleteForUser("u1", except "s2") removes u1's others but
     *           keeps s2 and leaves u2's session alone
     */
    it("deletes one session, or all of a user's except one", () => {
      const r = make()
      r.users.create(buildUser({ id: 'u1', username: 'ann' }))
      r.users.create(buildUser({ id: 'u2', username: 'bob' }))
      for (const [s, u] of [
        ['s1', 'u1'],
        ['s2', 'u1'],
        ['s3', 'u1'],
        ['s4', 'u2'],
      ] as const) {
        r.sessions.create(base(s, u))
      }
      r.sessions.delete('s1')
      expect(r.sessions.findWithUser('s1')).toBeUndefined()
      r.sessions.deleteForUser('u1', 's2')
      expect(r.sessions.findWithUser('s2')).toBeDefined()
      expect(r.sessions.findWithUser('s3')).toBeUndefined()
      expect(r.sessions.findWithUser('s4')).toBeDefined()
      r.sessions.deleteForUser('u1')
      expect(r.sessions.findWithUser('s2')).toBeUndefined()
    })
  })

  describe(`${label}: SpaceRepo`, () => {
    /**
     * Function: spaces.create, findById, listAll, update
     * Inputs:   spaces "Zoo" and "Apple"; then rename and archive "Apple"
     * Expected: listAll is ordered by name; update changes name and archivedAt
     */
    it('stores, lists by name, and updates spaces', () => {
      const r = make()
      r.spaces.create(buildSpace({ id: 'z', name: 'Zoo' }))
      r.spaces.create(buildSpace({ id: 'a', name: 'Apple', type: 'business' }))
      expect(r.spaces.listAll().map((s) => s.name)).toEqual(['Apple', 'Zoo'])
      r.spaces.update('a', { name: 'Pear', archivedAt: '2030-01-01T00:00:00.000Z' })
      expect(r.spaces.findById('a')).toMatchObject({
        name: 'Pear',
        type: 'business',
        archivedAt: '2030-01-01T00:00:00.000Z',
      })
      expect(r.spaces.findById('none')).toBeUndefined()
    })

    /**
     * Function: spaces.setMember, getRole, listMembers, listForUser, removeMember, countOwners
     * Inputs:   user "ann" added as viewer to space A, then changed to owner; "bob" added as
     *           editor; "ann" also a member of space B
     * Expected: setMember says "added" then "changed"; getRole reflects the change; listMembers
     *           is ordered by username; listForUser returns only that user's spaces with roles;
     *           countOwners counts owners; removeMember removes the row
     */
    it('manages memberships and answers who can see what', () => {
      const r = make()
      r.users.create(buildUser({ id: 'ua', username: 'ann' }))
      r.users.create(buildUser({ id: 'ub', username: 'bob' }))
      r.spaces.create(buildSpace({ id: 'A', name: 'Alpha' }))
      r.spaces.create(buildSpace({ id: 'B', name: 'Beta' }))

      expect(r.spaces.setMember('A', 'ua', 'viewer')).toBe('added')
      expect(r.spaces.setMember('A', 'ua', 'owner')).toBe('changed')
      r.spaces.setMember('A', 'ub', 'editor')
      r.spaces.setMember('B', 'ua', 'viewer')

      expect(r.spaces.getRole('A', 'ua')).toBe('owner')
      expect(r.spaces.getRole('B', 'ub')).toBeUndefined()
      expect(r.spaces.listMembers('A').map((m) => `${m.username}:${m.role}`)).toEqual([
        'ann:owner',
        'bob:editor',
      ])
      expect(r.spaces.listForUser('ua').map((x) => `${x.space.name}:${x.role}`)).toEqual([
        'Alpha:owner',
        'Beta:viewer',
      ])
      expect(r.spaces.countOwners('A')).toBe(1)

      r.spaces.removeMember('A', 'ub')
      expect(r.spaces.getRole('A', 'ub')).toBeUndefined()
    })

    /**
     * Function: spaces.setMember(spaceId, userId, role)
     * Inputs:   an unknown user id, and an unknown space id
     * Expected: throws MissingParentError both times (the database enforces foreign keys)
     */
    it('refuses memberships for unknown users or spaces', () => {
      const r = make()
      r.users.create(buildUser({ id: 'ua', username: 'ann' }))
      r.spaces.create(buildSpace({ id: 'A' }))
      expect(() => r.spaces.setMember('A', 'ghost', 'viewer')).toThrow(MissingParentError)
      expect(() => r.spaces.setMember('ghost', 'ua', 'viewer')).toThrow(MissingParentError)
    })
  })

  describe(`${label}: AuditRepo`, () => {
    /**
     * Function: audit.add(entry), audit.list({ limit, before })
     * Inputs:   entries at 10:00, 11:00, 12:00 (one with meta { role: "viewer" })
     * Expected: newest first; limit 2 returns the two newest; before 12:00 excludes the 12:00
     *           entry; meta round-trips as an object
     */
    it('stores entries and lists them newest first with limit and before', () => {
      const r = make()
      r.audit.add(audit({ id: 'a1', at: '2030-01-01T10:00:00.000Z' }))
      r.audit.add(audit({ id: 'a2', at: '2030-01-01T11:00:00.000Z', meta: { role: 'viewer' } }))
      r.audit.add(audit({ id: 'a3', at: '2030-01-01T12:00:00.000Z' }))
      expect(r.audit.list({ limit: 10 }).map((e) => e.id)).toEqual(['a3', 'a2', 'a1'])
      expect(r.audit.list({ limit: 2 }).map((e) => e.id)).toEqual(['a3', 'a2'])
      expect(
        r.audit.list({ limit: 10, before: '2030-01-01T12:00:00.000Z' }).map((e) => e.id),
      ).toEqual(['a2', 'a1'])
      expect(r.audit.list({ limit: 10 }).find((e) => e.id === 'a2')!.meta).toEqual({
        role: 'viewer',
      })
    })
  })

  /** Two Spaces (S1, S2) and one account in each (A1 in S1, A2 in S2). */
  const ledgerWorld = () => {
    const r = make()
    r.spaces.create(buildSpace({ id: 'S1', name: 'Home' }))
    r.spaces.create(buildSpace({ id: 'S2', name: 'Biz', type: 'business' }))
    r.accounts.create(buildAccount({ id: 'A1', name: 'Checking', primarySpaceId: 'S1' }))
    r.accounts.create(
      buildAccount({ id: 'A2', name: 'Biz Card', primarySpaceId: 'S2', type: 'credit_card' }),
    )
    return r
  }
  const sp = (id: string, spaceId: string, amountCents: number, categoryId?: string) =>
    buildSplit({ id, spaceId, amountCents, categoryId })

  describe(`${label}: AccountRepo`, () => {
    /**
     * Function: accounts.create, findById, listForSpace, update
     * Inputs:   accounts "Zed" and "Amy" in Space S1 and "Other" in S2; then archive "Zed"
     * Expected: listForSpace(S1) is ordered by name and only has S1 accounts; archived ones are
     *           hidden unless includeArchived; update changes the nickname; defaults are
     *           manual, included in net worth, not hidden
     */
    it('stores accounts per Space, hides archived ones, and updates fields', () => {
      const r = ledgerWorld()
      r.accounts.create(buildAccount({ id: 'z', name: 'Zed', primarySpaceId: 'S1' }))
      r.accounts.create(
        buildAccount({ id: 'a', name: 'Amy', primarySpaceId: 'S1', type: 'savings' }),
      )
      expect(r.accounts.listForSpace('S1').map((x) => x.name)).toEqual(['Amy', 'Checking', 'Zed'])
      expect(r.accounts.findById('a')).toMatchObject({
        type: 'savings',
        isManual: true,
        includeInNetWorth: true,
        hidden: false,
        syncEnabled: false,
        archivedAt: null,
      })
      r.accounts.update('z', { archivedAt: '2030-01-01T00:00:00.000Z', nickname: 'Old' })
      expect(r.accounts.listForSpace('S1').map((x) => x.name)).toEqual(['Amy', 'Checking'])
      expect(r.accounts.listForSpace('S1', { includeArchived: true }).map((x) => x.name)).toContain(
        'Zed',
      )
      expect(r.accounts.findById('z')!.nickname).toBe('Old')
      expect(r.accounts.listForSpace('S2').map((x) => x.name)).toEqual(['Biz Card'])
    })

    /**
     * Function: accounts.create(account)
     * Inputs:   an account whose primary Space doesn't exist
     * Expected: throws MissingParentError
     */
    it('refuses an account in an unknown Space', () => {
      const r = make()
      expect(() => r.accounts.create(buildAccount({ primarySpaceId: 'ghost' }))).toThrow(
        MissingParentError,
      )
    })
  })

  describe(`${label}: BalanceRepo`, () => {
    /**
     * Function: balances.upsert, listForAccount, latestForAccounts
     * Inputs:   balances for A1 on Jan 1 (100000), Jan 3 (120000) and a corrected Jan 1 (110000)
     * Expected: one row per day (the correction replaces Jan 1); listed newest first; limit works;
     *           latestForAccounts returns Jan 3 for A1 and nothing for A2 (no snapshots)
     */
    it('keeps one snapshot per account per day, newest first', () => {
      const r = ledgerWorld()
      const snap = (id: string, date: string, balanceCents: number) => ({
        id,
        accountId: 'A1',
        date,
        balanceCents,
        source: 'manual' as const,
      })
      r.balances.upsert(snap('b1', '2030-01-01', 100000))
      r.balances.upsert(snap('b2', '2030-01-03', 120000))
      r.balances.upsert({ ...snap('b3', '2030-01-01', 110000), availableCents: 90000 })
      const list = r.balances.listForAccount('A1')
      expect(list.map((b) => [b.date, b.balanceCents, b.availableCents])).toEqual([
        ['2030-01-03', 120000, null],
        ['2030-01-01', 110000, 90000],
      ])
      expect(r.balances.listForAccount('A1', { limit: 1 })).toHaveLength(1)
      expect(r.balances.latestForAccounts(['A1', 'A2']).map((b) => [b.accountId, b.date])).toEqual([
        ['A1', '2030-01-03'],
      ])
    })

    /**
     * Function: balances.upsert(snapshot)
     * Inputs:   a snapshot for an account that doesn't exist
     * Expected: throws MissingParentError
     */
    it('refuses a snapshot for an unknown account', () => {
      const r = make()
      expect(() =>
        r.balances.upsert({
          id: 'b',
          accountId: 'ghost',
          date: '2030-01-01',
          balanceCents: 1,
          source: 'manual',
        }),
      ).toThrow(MissingParentError)
    })
  })

  describe(`${label}: CategoryRepo`, () => {
    /**
     * Function: categories.create, listForSpace, update
     * Inputs:   categories in S1: expense "Rent" (sort 2), expense "Food" (sort 1), income "Pay",
     *           transfer "Transfer", plus one in S2; then archive "Food"
     * Expected: listed income, expense (by sortOrder, then name), transfer; only S1's;
     *           archived hidden unless asked; tax line stored
     */
    it('lists categories by kind and order, per Space, hiding archived', () => {
      const r = ledgerWorld()
      const cat = (
        id: string,
        name: string,
        kind: 'income' | 'expense' | 'transfer',
        sortOrder = 0,
        spaceId = 'S1',
      ) => r.categories.create(buildCategory({ id, name, kind, sortOrder, spaceId }))
      cat('c1', 'Rent', 'expense', 2)
      cat('c2', 'Food', 'expense', 1)
      cat('c3', 'Pay', 'income')
      cat('c4', 'Transfer', 'transfer')
      cat('c5', 'Other Space', 'expense', 0, 'S2')
      r.categories.update('c1', { taxLine: 'Schedule C, Line 20' })
      expect(r.categories.listForSpace('S1').map((c) => c.name)).toEqual([
        'Pay',
        'Food',
        'Rent',
        'Transfer',
      ])
      expect(r.categories.findById('c1')!.taxLine).toBe('Schedule C, Line 20')
      r.categories.update('c2', { archivedAt: '2030-01-01T00:00:00.000Z' })
      expect(r.categories.listForSpace('S1').map((c) => c.name)).toEqual([
        'Pay',
        'Rent',
        'Transfer',
      ])
      expect(r.categories.listForSpace('S1', { includeArchived: true })).toHaveLength(4)
    })
  })

  describe(`${label}: TransactionRepo (writes and the split invariant)`, () => {
    /**
     * Function: transactions.create(txn, splits), transactions.findById(id)
     * Inputs:   a -12500 transaction on A1 with two splits (-7500 categorized, -5000 not)
     * Expected: found with both splits, amounts intact, and the account summary (name, Space);
     *           defaults: active, not pending, not private
     */
    it('stores a transaction with its splits and returns them with the account', () => {
      const r = ledgerWorld()
      r.categories.create(buildCategory({ id: 'cat', spaceId: 'S1' }))
      r.transactions.create(buildTransaction({ id: 't1', accountId: 'A1', amountCents: -12500 }), [
        sp('s1', 'S1', -7500, 'cat'),
        sp('s2', 'S1', -5000),
      ])
      const found = r.transactions.findById('t1')!
      expect(found.txn).toMatchObject({
        amountCents: -12500,
        status: 'active',
        pending: false,
        private: false,
      })
      expect(found.splits.map((x) => [x.id, x.amountCents, x.categoryId])).toEqual([
        ['s1', -7500, 'cat'],
        ['s2', -5000, null],
      ])
      expect(found.account).toMatchObject({ id: 'A1', name: 'Checking', primarySpaceId: 'S1' })
      expect(r.transactions.findById('none')).toBeUndefined()
    })

    /**
     * Function: transactions.create(txn, splits) (split invariant, CLAUDE.md rule 3)
     * Inputs:   splits one cent short (-999 for a -1000 transaction); no splits at all; a
     *           fractional split amount (-500.5)
     * Expected: SplitInvariantError each time ("sum_mismatch", "no_splits", "not_integer") and
     *           nothing is stored
     */
    it('refuses splits that do not add up exactly, and stores nothing', () => {
      const r = ledgerWorld()
      const t = buildTransaction({ id: 't1', accountId: 'A1', amountCents: -1000 })
      const problem = (splits: ReturnType<typeof sp>[]) => {
        try {
          r.transactions.create(t, splits)
        } catch (e) {
          return e instanceof SplitInvariantError ? e.problem : 'other'
        }
        return 'no error'
      }
      expect(problem([sp('s1', 'S1', -999)])).toBe('sum_mismatch')
      expect(problem([])).toBe('no_splits')
      expect(problem([sp('s1', 'S1', -500.5), sp('s2', 'S1', -499.5)])).toBe('not_integer')
      expect(r.transactions.findById('t1')).toBeUndefined()
    })

    /**
     * Function: transactions.create(txn, splits) (parents and atomicity)
     * Inputs:   an unknown account; then a valid account with a split in an unknown Space
     * Expected: MissingParentError both times, and the failed second attempt leaves no
     *           half-written transaction behind
     */
    it('refuses unknown parents and leaves no partial rows', () => {
      const r = ledgerWorld()
      expect(() =>
        r.transactions.create(buildTransaction({ id: 't1', accountId: 'ghost' }), [
          sp('s1', 'S1', -1000),
        ]),
      ).toThrow(MissingParentError)
      expect(() =>
        r.transactions.create(buildTransaction({ id: 't2', accountId: 'A1' }), [
          sp('s2', 'ghost', -1000),
        ]),
      ).toThrow(MissingParentError)
      expect(r.transactions.findById('t2')).toBeUndefined()
    })

    /**
     * Function: transactions.create(txn, splits) (de-duplication by bank id)
     * Inputs:   externalId "bank-1" twice on A1; the same id on A2; two manual entries with no id
     * Expected: the repeat on A1 throws DuplicateError; A2 may reuse the id; null ids never clash
     */
    it('de-duplicates by (account, externalId) but not manual entries', () => {
      const r = ledgerWorld()
      const make1 = (id: string, accountId: string, externalId?: string) =>
        r.transactions.create(buildTransaction({ id, accountId, externalId }), [
          sp(`${id}-s`, accountId === 'A1' ? 'S1' : 'S2', -1000),
        ])
      make1('t1', 'A1', 'bank-1')
      expect(() => make1('t2', 'A1', 'bank-1')).toThrow(DuplicateError)
      expect(() => make1('t3', 'A2', 'bank-1')).not.toThrow()
      expect(() => make1('t4', 'A1')).not.toThrow()
      expect(() => make1('t5', 'A1')).not.toThrow()
    })

    /**
     * Function: transactions.update(id, patch, splits?)
     * Inputs:   a -1000 transaction with one split; (1) patch payee/memo/pending/private;
     *           (2) change the amount to -2000 with no splits; (3) change it to -2000 with a
     *           matching single split; (4) replace with two splits summing to -2000
     * Expected: (1) fields change; (2) SplitInvariantError and nothing changes; (3) both amount
     *           and split change; (4) the old split is replaced by the two new ones
     */
    it('updates fields and keeps splits balanced when the amount or splits change', () => {
      const r = ledgerWorld()
      r.transactions.create(buildTransaction({ id: 't1', accountId: 'A1', amountCents: -1000 }), [
        sp('s1', 'S1', -1000),
      ])

      r.transactions.update('t1', { payee: 'Acme', memo: 'note', pending: true, private: true })
      expect(r.transactions.findById('t1')!.txn).toMatchObject({
        payee: 'Acme',
        memo: 'note',
        pending: true,
        private: true,
      })

      expect(() => r.transactions.update('t1', { amountCents: -2000 })).toThrow(SplitInvariantError)
      expect(r.transactions.findById('t1')!.txn.amountCents).toBe(-1000)

      r.transactions.update('t1', { amountCents: -2000 }, [sp('s2', 'S1', -2000)])
      expect(r.transactions.findById('t1')!.splits.map((x) => [x.id, x.amountCents])).toEqual([
        ['s2', -2000],
      ])

      r.transactions.update('t1', {}, [sp('s3', 'S1', -1500), sp('s4', 'S2', -500)])
      expect(
        r.transactions.findById('t1')!.splits.map((x) => [x.id, x.spaceId, x.amountCents]),
      ).toEqual([
        ['s3', 'S1', -1500],
        ['s4', 'S2', -500],
      ])
      expect(r.transactions.findInvariantViolations()).toEqual([])
    })

    /**
     * Function: transactions.update(id, patch, splits)
     * Inputs:   replacement splits that don't sum to the amount
     * Expected: SplitInvariantError and the original splits are still in place
     */
    it('keeps the old splits when a replacement does not balance', () => {
      const r = ledgerWorld()
      r.transactions.create(buildTransaction({ id: 't1', accountId: 'A1', amountCents: -1000 }), [
        sp('s1', 'S1', -1000),
      ])
      expect(() =>
        r.transactions.update('t1', {}, [sp('s2', 'S1', -400), sp('s3', 'S1', -500)]),
      ).toThrow(SplitInvariantError)
      expect(r.transactions.findById('t1')!.splits.map((x) => x.id)).toEqual(['s1'])
    })
  })

  describe(`${label}: TransactionRepo.listForSpace`, () => {
    const seedList = () => {
      const r = ledgerWorld()
      r.categories.create(buildCategory({ id: 'groc', spaceId: 'S1', name: 'Groceries' }))
      const add = (
        id: string,
        accountId: string,
        date: string,
        amountCents: number,
        over = {},
        splits?: ReturnType<typeof sp>[],
      ) =>
        r.transactions.create(
          buildTransaction({ id, accountId, date, amountCents, ...over }),
          splits ?? [
            sp(
              `${id}-s`,
              accountId === 'A1' ? 'S1' : 'S2',
              amountCents,
              id === 't1' ? 'groc' : undefined,
            ),
          ],
        )
      add('t1', 'A1', '2030-01-10', -1000, { descriptionRaw: 'Corner Market', payee: 'Market' })
      add('t2', 'A1', '2030-01-12', -2500, { descriptionRaw: '100% Organic_Co' })
      add('t3', 'A1', '2030-01-12', -300, { descriptionRaw: 'Coffee', memo: 'with market friends' })
      add('t4', 'A2', '2030-01-11', -4000, { descriptionRaw: 'Office chair' })
      return { r, add }
    }

    /**
     * Function: transactions.listForSpace(spaceId, filters, page)
     * Inputs:   S1 has t1 (Jan 10), t2 and t3 (both Jan 12) on its account; S2 has t4 on its own
     * Expected: S1 sees t3, t2 (newest date first, ties by id descending) then t1; S2 sees only
     *           t4; total reflects all matches before paging; limit/offset page correctly
     */
    it("lists a Space's transactions newest first with a total and paging", () => {
      const { r } = seedList()
      const all = r.transactions.listForSpace('S1', {}, { limit: 50, offset: 0 })
      expect(all.rows.map((x) => x.txn.id)).toEqual(['t3', 't2', 't1'])
      expect(all.total).toBe(3)
      expect(
        r.transactions.listForSpace('S2', {}, { limit: 50, offset: 0 }).rows.map((x) => x.txn.id),
      ).toEqual(['t4'])
      const page = r.transactions.listForSpace('S1', {}, { limit: 1, offset: 1 })
      expect(page.rows.map((x) => x.txn.id)).toEqual(['t2'])
      expect(page.total).toBe(3)
    })

    /**
     * Function: transactions.listForSpace(spaceId, filters, page) (cross-Space splits)
     * Inputs:   a -6000 transaction on S2's account A2 split -4000 into S2 and -2000 into S1
     * Expected: it appears for S1 (it has a split there) and for S2 (its account's Space), with
     *           all of its splits returned so the caller can apply privacy rules
     */
    it("includes transactions on other Spaces' accounts that have a split here", () => {
      const { r, add } = seedList()
      add('t9', 'A2', '2030-01-13', -6000, {}, [sp('t9-a', 'S2', -4000), sp('t9-b', 'S1', -2000)])
      const forS1 = r.transactions.listForSpace('S1', {}, { limit: 50, offset: 0 })
      expect(forS1.rows.map((x) => x.txn.id)).toEqual(['t9', 't3', 't2', 't1'])
      expect(forS1.rows[0]!.splits).toHaveLength(2)
      expect(
        r.transactions.listForSpace('S2', {}, { limit: 50, offset: 0 }).rows.map((x) => x.txn.id),
      ).toContain('t9')
    })

    /**
     * Function: transactions.listForSpace(spaceId, filters, page) (filters)
     * Inputs:   S1 filtered by account A1; by category "groc"; by dates Jan 11..Jan 12; by text
     *           "market" (matches t1's description/payee and t3's memo); by text "100%" (a
     *           literal percent sign); by text "organic_co" (a literal underscore)
     * Expected: t1/t2/t3; t1 only; t3 and t2; t3 and t1; t2 only; t2 only. Wildcard characters
     *           in the search text are matched literally
     */
    it('filters by account, category, date range and text', () => {
      const { r } = seedList()
      const ids = (f: Parameters<typeof r.transactions.listForSpace>[1]) =>
        r.transactions.listForSpace('S1', f, { limit: 50, offset: 0 }).rows.map((x) => x.txn.id)
      expect(ids({ accountId: 'A1' }).sort()).toEqual(['t1', 't2', 't3'])
      expect(ids({ categoryId: 'groc' })).toEqual(['t1'])
      expect(ids({ from: '2030-01-11', to: '2030-01-12' })).toEqual(['t3', 't2'])
      expect(ids({ q: 'market' })).toEqual(['t3', 't1'])
      expect(ids({ q: '100%' })).toEqual(['t2'])
      expect(ids({ q: 'organic_co' })).toEqual(['t2'])
    })

    /**
     * Function: transactions.listForSpace(spaceId, filters, page) (removed transactions)
     * Inputs:   t2 marked status "removed"
     * Expected: t2 no longer listed and not counted in the total
     */
    it('leaves out removed transactions', () => {
      const { r } = seedList()
      r.transactions.update('t2', { status: 'removed' })
      const out = r.transactions.listForSpace('S1', {}, { limit: 50, offset: 0 })
      expect(out.rows.map((x) => x.txn.id)).toEqual(['t3', 't1'])
      expect(out.total).toBe(2)
    })
  })

  describe(`${label}: TransferRepo`, () => {
    const withTwoTxns = () => {
      const r = ledgerWorld()
      r.transactions.create(buildTransaction({ id: 'out', accountId: 'A1', amountCents: -5000 }), [
        sp('o', 'S1', -5000),
      ])
      r.transactions.create(buildTransaction({ id: 'in', accountId: 'A2', amountCents: 5000 }), [
        sp('i', 'S2', 5000),
      ])
      r.transactions.create(buildTransaction({ id: 'other', accountId: 'A2', amountCents: 5000 }), [
        sp('x', 'S2', 5000),
      ])
      return r
    }

    /**
     * Function: transfers.create, findByTransaction, delete
     * Inputs:   a link from "out" to "in"; look it up from each side; then delete it
     * Expected: found from both transactions with createdBy "user"; gone after delete
     */
    it('links two transactions, finds the link from either side, and unlinks', () => {
      const r = withTwoTxns()
      r.transfers.create({
        id: 'l1',
        fromTransactionId: 'out',
        toTransactionId: 'in',
        createdBy: 'user',
      })
      expect(r.transfers.findByTransaction('out')).toMatchObject({ id: 'l1', createdBy: 'user' })
      expect(r.transfers.findByTransaction('in')).toMatchObject({ id: 'l1' })
      expect(r.transfers.findByTransaction('other')).toBeUndefined()
      r.transfers.delete('l1')
      expect(r.transfers.findByTransaction('out')).toBeUndefined()
    })

    /**
     * Function: transfers.create(link)
     * Inputs:   a second link reusing "out" as the money-out side; one with an unknown transaction
     * Expected: DuplicateError for the reuse; MissingParentError for the unknown transaction
     */
    it('refuses a transaction already linked, and unknown transactions', () => {
      const r = withTwoTxns()
      r.transfers.create({
        id: 'l1',
        fromTransactionId: 'out',
        toTransactionId: 'in',
        createdBy: 'user',
      })
      expect(() =>
        r.transfers.create({
          id: 'l2',
          fromTransactionId: 'out',
          toTransactionId: 'other',
          createdBy: 'user',
        }),
      ).toThrow(DuplicateError)
      expect(() =>
        r.transfers.create({
          id: 'l3',
          fromTransactionId: 'ghost',
          toTransactionId: 'other',
          createdBy: 'user',
        }),
      ).toThrow(MissingParentError)
    })
  })

  describe(`${label}: ConnectionRepo and synced accounts`, () => {
    const withUser = () => {
      const r = ledgerWorld()
      r.users.create(buildUser({ id: 'adm', username: 'adm', isAdmin: true }))
      return r
    }

    /**
     * Function: connections.create, findById, list, update
     * Inputs:   connections "Zeta Bank" and "Alpha Bank" created by "adm"; then Alpha marked error
     *           with a message, then revoked with its access URL cleared
     * Expected: listed by label; new ones are active with no sync time; update stores status,
     *           lastSyncedAt and lastError; revoke leaves accessUrlEnc null
     */
    it('stores connections and tracks their status', () => {
      const r = withUser()
      r.connections.create({
        id: 'c1',
        label: 'Zeta Bank',
        accessUrlEnc: 'v1:a:b',
        createdBy: 'adm',
      })
      r.connections.create({
        id: 'c2',
        label: 'Alpha Bank',
        accessUrlEnc: 'v1:c:d',
        createdBy: 'adm',
      })
      expect(r.connections.list().map((c) => c.label)).toEqual(['Alpha Bank', 'Zeta Bank'])
      expect(r.connections.findById('c2')).toMatchObject({
        status: 'active',
        lastSyncedAt: null,
        lastError: null,
        accessUrlEnc: 'v1:c:d',
      })
      r.connections.update('c2', {
        status: 'error',
        lastError: 'bad',
        lastSyncedAt: '2030-01-01T00:00:00.000Z',
      })
      expect(r.connections.findById('c2')).toMatchObject({
        status: 'error',
        lastError: 'bad',
        lastSyncedAt: '2030-01-01T00:00:00.000Z',
      })
      r.connections.update('c2', { status: 'revoked', accessUrlEnc: null })
      expect(r.connections.findById('c2')!.accessUrlEnc).toBeNull()
      expect(r.connections.findById('none')).toBeUndefined()
    })

    /**
     * Function: connections.create(connection)
     * Inputs:   a connection created by a user that doesn't exist
     * Expected: throws MissingParentError
     */
    it('refuses a connection from an unknown user', () => {
      expect(() =>
        make().connections.create({ id: 'c', label: 'x', accessUrlEnc: null, createdBy: 'ghost' }),
      ).toThrow(MissingParentError)
    })

    /**
     * Function: accounts.create (bank-fed), findByExternal, listForConnection, update
     * Inputs:   two bank accounts "ACT-1" and "ACT-2" on connection c1 (unassigned, hidden), the
     *           same bank id "ACT-1" again on c1 and on another connection c2; then assign ACT-1
     *           to Space S1 with syncing on
     * Expected: findByExternal returns the right one; the duplicate on c1 throws DuplicateError
     *           while c2 may reuse the id; an unknown connection throws MissingParentError;
     *           listForConnection is by name; update stores the Space and sync flag
     */
    it('keeps one local account per bank account and connection', () => {
      const r = withUser()
      r.connections.create({ id: 'c1', label: 'One', accessUrlEnc: 'x', createdBy: 'adm' })
      r.connections.create({ id: 'c2', label: 'Two', accessUrlEnc: 'x', createdBy: 'adm' })
      const bank = (id: string, name: string, connectionId: string, externalId: string) =>
        r.accounts.create(
          buildAccount({
            id,
            name,
            connectionId,
            externalId,
            isManual: false,
            hidden: true,
            syncEnabled: false,
          }),
        )
      bank('a2', 'Savings', 'c1', 'ACT-2')
      bank('a1', 'Checking', 'c1', 'ACT-1')
      expect(r.accounts.findByExternal('c1', 'ACT-1')).toMatchObject({
        id: 'a1',
        isManual: false,
        hidden: true,
        syncEnabled: false,
        primarySpaceId: null,
      })
      expect(r.accounts.findByExternal('c1', 'nope')).toBeUndefined()
      expect(() => bank('a3', 'Dupe', 'c1', 'ACT-1')).toThrow(DuplicateError)
      expect(() => bank('a4', 'Other bank', 'c2', 'ACT-1')).not.toThrow()
      expect(() => bank('a5', 'Orphan', 'ghost', 'ACT-9')).toThrow(MissingParentError)
      expect(r.accounts.listForConnection('c1').map((a) => a.name)).toEqual(['Checking', 'Savings'])
      r.accounts.update('a1', { primarySpaceId: 'S1', hidden: false, syncEnabled: true })
      expect(r.accounts.findById('a1')).toMatchObject({
        primarySpaceId: 'S1',
        hidden: false,
        syncEnabled: true,
      })
    })
  })

  describe(`${label}: TransactionRepo (bank-fed lookups)`, () => {
    /**
     * Function: transactions.findByExternalId, listForAccountSince, countForAccount, update
     * Inputs:   three transactions on A1 (two with bank ids, one manual) and one on A2; mark one
     *           pending as removed and superseded by another
     * Expected: findByExternalId finds by (account, bank id) in any status; listForAccountSince
     *           returns only that account's transactions on/after the date, any status;
     *           countForAccount counts them all; userEdited and supersededBy are stored
     */
    it('finds bank-fed transactions, lists a window, counts, and tracks edits and supersession', () => {
      const r = ledgerWorld()
      const add = (id: string, accountId: string, date: string, externalId?: string) =>
        r.transactions.create(
          buildTransaction({
            id,
            accountId,
            date,
            externalId,
            source: externalId ? 'simplefin' : 'manual',
            pending: id === 'p1',
          }),
          [sp(`${id}-s`, accountId === 'A1' ? 'S1' : 'S2', -1000)],
        )
      add('p1', 'A1', '2030-01-10', 'BANK-P')
      add('t2', 'A1', '2030-01-12', 'BANK-2')
      add('t3', 'A1', '2030-01-02')
      add('t4', 'A2', '2030-01-12', 'BANK-2')
      expect(r.transactions.findByExternalId('A1', 'BANK-2')!.txn.id).toBe('t2')
      expect(r.transactions.findByExternalId('A2', 'BANK-2')!.txn.id).toBe('t4')
      expect(r.transactions.findByExternalId('A1', 'nope')).toBeUndefined()

      r.transactions.update('p1', { status: 'removed', supersededBy: 't2', userEdited: true })
      expect(r.transactions.findById('p1')!.txn).toMatchObject({
        status: 'removed',
        supersededBy: 't2',
        userEdited: true,
      })
      expect(r.transactions.listForAccountSince('A1', '2030-01-05').map((x) => x.txn.id)).toEqual([
        't2',
        'p1',
      ])
      expect(r.transactions.countForAccount('A1')).toBe(3)
      expect(r.transactions.countForAccount('A2')).toBe(1)
    })
  })
}
