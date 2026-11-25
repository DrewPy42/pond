import { applyOps, collectOps, defineMigration } from '@pond/sdk'
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
     * Function: spaces.contents
     * Inputs:   Space S1 with an account; S2 with only a split from S1's account; S3 with only a
     *           LilyPad row; S4 with categories, a member, a rule and settings but no records
     * Expected: each kind of record is counted where it is; S4 reads as empty
     */
    it('counts what a Space holds that must not be destroyed', async () => {
      const r = make()
      for (const id of ['S1', 'S2', 'S3', 'S4']) r.spaces.create(buildSpace({ id, name: id }))
      r.accounts.create(buildAccount({ id: 'A1', primarySpaceId: 'S1', currency: 'USD' }))
      r.transactions.create(buildTransaction({ id: 't1', accountId: 'A1', amountCents: -500 }), [
        buildSplit({ id: 's1', spaceId: 'S2', amountCents: -500 }),
      ])
      const migration = defineMigration('0001', (m) =>
        m.createTable('notes', { columns: { title: 'text' } }),
      )
      const schema = applyOps({}, collectOps(migration))
      r.padStore.applyOps('kept', collectOps(migration))
      await r.padStore.table('kept', schema, 'notes', 'S3').insert({ title: 'x' })

      r.users.create(buildUser({ id: 'u1', username: 'ann' }))
      r.spaces.setMember('S4', 'u1', 'owner')
      r.categories.create(buildCategory({ id: 'c4', spaceId: 'S4' }))
      r.settings.set('space', 'S4', 'lp.kept.x', true)

      expect(r.spaces.contents('S1')).toEqual({ accounts: 1, splits: 0, appRows: 0 })
      expect(r.spaces.contents('S2')).toEqual({ accounts: 0, splits: 1, appRows: 0 })
      expect(r.spaces.contents('S3')).toEqual({ accounts: 0, splits: 0, appRows: 1 })
      expect(r.spaces.contents('S4')).toEqual({ accounts: 0, splits: 0, appRows: 0 })
    })

    /**
     * Function: spaces.delete
     * Inputs:   an empty Space with a member, a category, a rule, an app switched on, a job run and
     *           a setting, next to a second Space with the same kinds of set-up; then a Space that
     *           still has an account
     * Expected: the empty Space and all its set-up are gone and the other Space's is untouched;
     *           deleting the Space with an account fails and removes nothing
     */
    it('deletes an empty Space with its set-up, and nothing else', () => {
      const r = make()
      r.users.create(buildUser({ id: 'u1', username: 'ann' }))
      for (const id of ['gone', 'kept']) {
        r.spaces.create(buildSpace({ id, name: id }))
        r.spaces.setMember(id, 'u1', 'owner')
        r.categories.create(buildCategory({ id: `cat-${id}`, spaceId: id }))
        r.rules.create({
          id: `rule-${id}`,
          spaceId: id,
          name: 'r',
          priority: 1,
          enabled: true,
          conditions: [],
          actions: [],
          createdBy: 'u1',
        })
        r.pads.enablement.enable('notes', id, 'u1', '2030-01-01T00:00:00.000Z')
        r.pads.jobRuns.set('notes', 'tidy', id, '2030-01-01T00:00:00.000Z')
        r.settings.set('space', id, 'lp.notes.x', 1)
      }
      r.spaces.delete('gone')
      expect(r.spaces.findById('gone')).toBeUndefined()
      expect(r.spaces.getRole('gone', 'u1')).toBeUndefined()
      expect(r.categories.findById('cat-gone')).toBeUndefined()
      expect(r.rules.findById('rule-gone')).toBeUndefined()
      expect(r.pads.enablement.padsForSpace('gone')).toEqual([])
      expect(r.pads.jobRuns.get('notes', 'tidy', 'gone')).toBeUndefined()
      expect(r.settings.get('space', 'gone', 'lp.notes.x')).toBeUndefined()

      expect(r.spaces.getRole('kept', 'u1')).toBe('owner')
      expect(r.categories.findById('cat-kept')).toBeDefined()
      expect(r.rules.findById('rule-kept')).toBeDefined()
      expect(r.pads.enablement.padsForSpace('kept')).toEqual(['notes'])
      expect(r.settings.get('space', 'kept', 'lp.notes.x')).toBe(1)

      r.accounts.create(buildAccount({ id: 'A9', primarySpaceId: 'kept' }))
      expect(() => r.spaces.delete('kept')).toThrow()
      expect(r.spaces.findById('kept')).toBeDefined()
      expect(r.categories.findById('cat-kept')).toBeDefined()
      expect(r.spaces.getRole('kept', 'u1')).toBe('owner')
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

  describe(`${label}: RuleRepo`, () => {
    const withUser = () => {
      const r = ledgerWorld()
      r.users.create(buildUser({ id: 'adm', username: 'adm', isAdmin: true }))
      return r
    }
    const rule = (id: string, spaceId: string, priority: number, over = {}) => ({
      id,
      spaceId,
      name: `Rule ${id}`,
      priority,
      enabled: true,
      conditions: [
        {
          type: 'text' as const,
          field: 'description' as const,
          op: 'contains' as const,
          value: 'market',
        },
      ],
      actions: [{ type: 'set_payee' as const, payee: 'Market' }],
      createdBy: 'adm',
      ...over,
    })

    /**
     * Function: rules.create, findById, listForSpace, update, delete
     * Inputs:   rules r2 (priority 20), r1 (priority 10) and r3 (priority 10) in Space S1, and one
     *           in S2; then change r1's name/enabled/conditions/actions; then delete r3
     * Expected: listed by priority then id for S1 only; conditions and actions round-trip as
     *           structured data; update changes only the given fields; delete removes the rule
     */
    it('stores rules per Space in priority order, with structured conditions and actions', () => {
      const r = withUser()
      r.rules.create(rule('r2', 'S1', 20))
      r.rules.create(rule('r1', 'S1', 10))
      r.rules.create(rule('r3', 'S1', 10))
      r.rules.create(rule('rx', 'S2', 1))
      expect(r.rules.listForSpace('S1').map((x) => x.id)).toEqual(['r1', 'r3', 'r2'])
      expect(r.rules.findById('r1')).toMatchObject({
        enabled: true,
        createdBy: 'adm',
        actions: [{ type: 'set_payee', payee: 'Market' }],
      })
      r.rules.update('r1', {
        name: 'Renamed',
        enabled: false,
        conditions: [{ type: 'direction', direction: 'out' }],
        actions: [{ type: 'mark_reimbursable' }],
      })
      expect(r.rules.findById('r1')).toMatchObject({
        name: 'Renamed',
        enabled: false,
        priority: 10,
        conditions: [{ type: 'direction', direction: 'out' }],
        actions: [{ type: 'mark_reimbursable' }],
      })
      r.rules.delete('r3')
      expect(r.rules.listForSpace('S1').map((x) => x.id)).toEqual(['r1', 'r2'])
      expect(r.rules.findById('none')).toBeUndefined()
    })

    /**
     * Function: rules.create(rule)
     * Inputs:   a rule in an unknown Space; a rule by an unknown user
     * Expected: MissingParentError both times
     */
    it('refuses a rule with an unknown Space or creator', () => {
      const r = withUser()
      expect(() => r.rules.create(rule('a', 'ghost', 1))).toThrow(MissingParentError)
      expect(() => r.rules.create(rule('b', 'S1', 1, { createdBy: 'ghost' }))).toThrow(
        MissingParentError,
      )
    })
  })

  describe(`${label}: ImportBatchRepo and transaction batch link`, () => {
    /**
     * Function: importBatches.create, findById, listForAccounts; transactions.create with importBatchId
     * Inputs:   two batches on A1 and one on A2 by "adm"; a transaction created with batch b1
     * Expected: found by id with their column map; listed newest first for the given accounts only;
     *           the transaction keeps its importBatchId; an unknown account or user is refused
     */
    it('records import batches and links transactions to them', () => {
      const r = ledgerWorld()
      r.users.create(buildUser({ id: 'adm', username: 'adm', isAdmin: true }))
      const batch = (id: string, accountId: string) => ({
        id,
        accountId,
        filename: `${id}.csv`,
        format: 'csv' as const,
        columnMap: { date: 0 },
        status: 'done' as const,
        rowCount: 3,
        createdBy: 'adm',
      })
      r.importBatches.create(batch('b1', 'A1'))
      r.importBatches.create(batch('b2', 'A1'))
      r.importBatches.create(batch('b3', 'A2'))
      expect(r.importBatches.findById('b1')).toMatchObject({
        filename: 'b1.csv',
        rowCount: 3,
        columnMap: { date: 0 },
      })
      expect(r.importBatches.listForAccounts(['A1']).map((b) => b.id)).toEqual(['b2', 'b1'])
      expect(r.importBatches.listForAccounts([])).toEqual([])
      expect(() => r.importBatches.create(batch('b4', 'ghost'))).toThrow(MissingParentError)
      r.transactions.create(
        buildTransaction({ id: 't1', accountId: 'A1', source: 'csv', importBatchId: 'b1' }),
        [sp('s1', 'S1', -1000)],
      )
      expect(r.transactions.findById('t1')!.txn.importBatchId).toBe('b1')
    })
  })

  describe(`${label}: TransactionRepo.findOppositeCandidates`, () => {
    /**
     * Function: transactions.findOppositeCandidates({ amountCents, excludeAccountId, currency, from, to })
     * Inputs:   a -5000 on A1 wanting +5000 elsewhere; candidates: +5000 on A2 (Jan 12, ok), +5000
     *           on A2 (Jan 30, too late), +4999 on A2, +5000 on A1 itself, a removed +5000, one
     *           already linked in a transfer, and one on a EUR account
     * Expected: only the Jan 12 transaction on A2 comes back
     */
    it('finds unlinked, active, same-currency opposite amounts on other accounts in range', () => {
      const r = ledgerWorld()
      r.accounts.create(
        buildAccount({ id: 'A3', name: 'Euro', currency: 'EUR', primarySpaceId: 'S1' }),
      )
      const add = (id: string, accountId: string, date: string, amountCents: number) =>
        r.transactions.create(buildTransaction({ id, accountId, date, amountCents }), [
          sp(`${id}-s`, accountId === 'A2' ? 'S2' : 'S1', amountCents),
        ])
      add('out', 'A1', '2030-01-10', -5000)
      add('good', 'A2', '2030-01-12', 5000)
      add('late', 'A2', '2030-01-30', 5000)
      add('off', 'A2', '2030-01-12', 4999)
      add('same', 'A1', '2030-01-12', 5000)
      add('gone', 'A2', '2030-01-12', 5000)
      r.transactions.update('gone', { status: 'removed' })
      add('linked', 'A2', '2030-01-12', 5000)
      add('partner', 'A1', '2030-01-12', -5000)
      r.transfers.create({
        id: 'l1',
        fromTransactionId: 'partner',
        toTransactionId: 'linked',
        createdBy: 'user',
      })
      add('euro', 'A3', '2030-01-12', 5000)
      const found = r.transactions.findOppositeCandidates({
        amountCents: 5000,
        excludeAccountId: 'A1',
        currency: 'USD',
        from: '2030-01-05',
        to: '2030-01-15',
      })
      expect(found.map((t) => t.txn.id)).toEqual(['good'])
    })
  })

  describe(`${label}: PadRepo (installs, enablement, migrations, job runs)`, () => {
    const world = () => {
      const r = ledgerWorld()
      r.users.create(buildUser({ id: 'adm', username: 'adm', isAdmin: true }))
      return r
    }
    const install = (padId: string, over = {}) => ({
      padId,
      version: '1.0.0',
      tier: 'official' as const,
      permissionsGranted: ['transactions:read'],
      installedBy: 'adm',
      installedAt: '2030-01-01T00:00:00.000Z',
      enabled: true,
      ...over,
    })

    /**
     * Function: pads.installs.upsert, get, list, delete
     * Inputs:   install "b" then "a"; re-install "a" with a new version and more permissions; delete "b"
     * Expected: listed by pad id; upsert replaces the record (permissions round-trip as a list);
     *           delete removes it; an unknown installer is refused (MissingParentError)
     */
    it('records installs and replaces them on upsert', () => {
      const r = world()
      r.pads.installs.upsert(install('b'))
      r.pads.installs.upsert(install('a'))
      expect(r.pads.installs.list().map((i) => i.padId)).toEqual(['a', 'b'])
      r.pads.installs.upsert(
        install('a', {
          version: '1.1.0',
          permissionsGranted: ['transactions:read', 'accounts:read'],
        }),
      )
      expect(r.pads.installs.get('a')).toMatchObject({
        version: '1.1.0',
        permissionsGranted: ['transactions:read', 'accounts:read'],
        enabled: true,
      })
      r.pads.installs.delete('b')
      expect(r.pads.installs.get('b')).toBeUndefined()
      expect(() => r.pads.installs.upsert(install('c', { installedBy: 'ghost' }))).toThrow(
        MissingParentError,
      )
    })

    /**
     * Function: pads.enablement.enable, disable, isEnabled, padsForSpace, spacesForPad, removeAllForPad
     * Inputs:   enable "a" for S1 and S2 and "b" for S1 (enabling twice is harmless); disable "a" in S2;
     *           then remove all of "a"
     * Expected: the lookups reflect each change; unknown Space or user gives MissingParentError
     */
    it('tracks which pads are on in which Spaces', () => {
      const r = world()
      r.pads.enablement.enable('a', 'S1', 'adm', '2030-01-01T00:00:00.000Z')
      r.pads.enablement.enable('a', 'S1', 'adm', '2030-01-02T00:00:00.000Z')
      r.pads.enablement.enable('a', 'S2', 'adm', '2030-01-01T00:00:00.000Z')
      r.pads.enablement.enable('b', 'S1', 'adm', '2030-01-01T00:00:00.000Z')
      expect(r.pads.enablement.padsForSpace('S1')).toEqual(['a', 'b'])
      expect(r.pads.enablement.spacesForPad('a')).toEqual(['S1', 'S2'])
      r.pads.enablement.disable('a', 'S2')
      expect(r.pads.enablement.isEnabled('a', 'S2')).toBe(false)
      expect(r.pads.enablement.isEnabled('a', 'S1')).toBe(true)
      r.pads.enablement.removeAllForPad('a')
      expect(r.pads.enablement.padsForSpace('S1')).toEqual(['b'])
      expect(() => r.pads.enablement.enable('a', 'ghost', 'adm', 'x')).toThrow(MissingParentError)
      expect(() => r.pads.enablement.enable('a', 'S1', 'ghost', 'x')).toThrow(MissingParentError)
    })

    /**
     * Function: pads.migrations.record, applied, removeAllForPad; pads.jobRuns.get, set, removeAllForPad
     * Inputs:   migrations "0001" and "0002" for pad "a" and "0001" for "b"; a job run set twice; removal
     * Expected: applied lists a pad's migrations in order; job runs keep the latest time per pad, job and
     *           Space; removeAllForPad clears only that pad
     */
    it('records applied migrations and job runs per pad', () => {
      const r = world()
      r.pads.migrations.record('a', '0001', '2030-01-01T00:00:00.000Z')
      r.pads.migrations.record('a', '0002', '2030-01-02T00:00:00.000Z')
      r.pads.migrations.record('b', '0001', '2030-01-01T00:00:00.000Z')
      expect(r.pads.migrations.applied('a')).toEqual(['0001', '0002'])
      r.pads.jobRuns.set('a', 'rollup', 'S1', '2030-01-01T06:00:00.000Z')
      r.pads.jobRuns.set('a', 'rollup', 'S1', '2030-02-01T06:00:00.000Z')
      r.pads.jobRuns.set('b', 'rollup', 'S1', '2030-01-01T06:00:00.000Z')
      expect(r.pads.jobRuns.get('a', 'rollup', 'S1')).toBe('2030-02-01T06:00:00.000Z')
      expect(r.pads.jobRuns.get('a', 'rollup', 'S2')).toBeUndefined()
      r.pads.migrations.removeAllForPad('a')
      r.pads.jobRuns.removeAllForPad('a')
      expect(r.pads.migrations.applied('a')).toEqual([])
      expect(r.pads.migrations.applied('b')).toEqual(['0001'])
      expect(r.pads.jobRuns.get('a', 'rollup', 'S1')).toBeUndefined()
      expect(r.pads.jobRuns.get('b', 'rollup', 'S1')).toBeDefined()
    })
  })

  describe(`${label}: SettingsRepo`, () => {
    /**
     * Function: settings.get, set, deleteByPrefix
     * Inputs:   a global and a per-Space setting under "lp.notes.", a structured value, an overwrite, and
     *           a setting under another prefix; then deleteByPrefix("lp.notes.")
     * Expected: values round-trip (including objects); overwriting replaces; scopes don't mix; the prefix
     *           delete removes only that pad's settings
     */
    it("stores settings by scope and removes a pad's by prefix", () => {
      const r = make()
      r.settings.set('global', '', 'lp.notes.theme', 'dark')
      r.settings.set('space', 'S1', 'lp.notes.showDone', true)
      r.settings.set('space', 'S1', 'lp.notes.cfg', { a: [1, 2] })
      r.settings.set('space', 'S1', 'lp.notes.showDone', false)
      r.settings.set('global', '', 'lp.other.x', 1)
      expect(r.settings.get('global', '', 'lp.notes.theme')).toBe('dark')
      expect(r.settings.get('space', 'S1', 'lp.notes.showDone')).toBe(false)
      expect(r.settings.get('space', 'S1', 'lp.notes.cfg')).toEqual({ a: [1, 2] })
      expect(r.settings.get('space', 'S2', 'lp.notes.showDone')).toBeUndefined()
      r.settings.deleteByPrefix('lp.notes.')
      expect(r.settings.get('global', '', 'lp.notes.theme')).toBeUndefined()
      expect(r.settings.get('space', 'S1', 'lp.notes.cfg')).toBeUndefined()
      expect(r.settings.get('global', '', 'lp.other.x')).toBe(1)
    })
  })

  describe(`${label}: ReportRepo.sumSplits`, () => {
    const seedMoney = () => {
      const r = ledgerWorld()
      r.accounts.create(buildAccount({ id: 'A3', name: 'Savings', primarySpaceId: 'S1' }))
      for (const [id, name, kind] of [
        ['food', 'Food', 'expense'],
        ['pay', 'Pay', 'income'],
        ['xfer', 'Transfer', 'transfer'],
      ] as const) {
        r.categories.create(buildCategory({ id, spaceId: 'S1', name, kind }))
      }
      const add = (
        id: string,
        accountId: string,
        date: string,
        amountCents: number,
        categoryId?: string,
        spaceId = 'S1',
      ) =>
        r.transactions.create(buildTransaction({ id, accountId, date, amountCents }), [
          sp(`${id}-s`, spaceId, amountCents, categoryId),
        ])
      add('groc', 'A1', '2030-01-10', -3000, 'food')
      add('coffee', 'A1', '2030-01-12', -500, 'food')
      add('paycheck', 'A1', '2030-01-15', 200000, 'pay')
      add('misc', 'A1', '2030-01-20', -700)
      add('xfercat', 'A1', '2030-01-21', -5000, 'xfer')
      add('out', 'A1', '2030-01-22', -9000)
      add('in', 'A3', '2030-01-22', 9000)
      r.transfers.create({
        id: 'l1',
        fromTransactionId: 'out',
        toTransactionId: 'in',
        createdBy: 'user',
      })
      add('gone', 'A1', '2030-01-11', -1000, 'food')
      r.transactions.update('gone', { status: 'removed' })
      add('feb', 'A1', '2030-02-03', -400, 'food')
      add('other', 'A2', '2030-01-10', -999, undefined, 'S2')
      return r
    }
    const row = (
      categoryId: string | null,
      kind: string | null,
      month: string | null,
      cents: number,
      count: number,
    ) => ({ categoryId, kind, month, cents, count })

    /**
     * Function: reports.sumSplits(spaceId, { groupBy: "category", from, to })
     * Inputs:   January 2030 in Space S1: food -3000 and -500, pay +200000, an uncategorized -700, a
     *           transfer-kind category -5000, a linked transfer pair (-9000 / +9000), a removed -1000 food,
     *           a February -400, and another Space's -999
     * Expected: one row per category: food -3500 (2), pay +200000 (1), uncategorized -700 (1). Transfer-kind
     *           categories, linked transfers, removed transactions, other months and other Spaces are left out
     */
    it('totals splits by category, leaving out transfers, removed transactions and other Spaces', () => {
      const r = seedMoney()
      const rows = r.reports.sumSplits('S1', {
        from: '2030-01-01',
        to: '2030-01-31',
        groupBy: 'category',
      })
      expect(rows).toEqual([
        row(null, null, null, -700, 1),
        row('food', 'expense', null, -3500, 2),
        row('pay', 'income', null, 200000, 1),
      ])
    })

    /**
     * Function: reports.sumSplits (month and category_month grouping)
     * Inputs:   January and February, grouped by month and by category_month
     * Expected: by month: Jan -4700+... as signed totals per month (Jan 195800, Feb -400); by
     *           category_month: separate rows per category and month
     */
    it('groups by month and by category and month', () => {
      const r = seedMoney()
      const byMonth = r.reports.sumSplits('S1', {
        from: '2030-01-01',
        to: '2030-02-28',
        groupBy: 'month',
      })
      expect(byMonth).toEqual([
        row(null, null, '2030-01', 195800, 4),
        row(null, null, '2030-02', -400, 1),
      ])
      const both = r.reports.sumSplits('S1', {
        from: '2030-01-01',
        to: '2030-02-28',
        groupBy: 'category_month',
      })
      expect(both.map((x) => [x.categoryId, x.month, x.cents])).toEqual([
        [null, '2030-01', -700],
        ['food', '2030-01', -3500],
        ['food', '2030-02', -400],
        ['pay', '2030-01', 200000],
      ])
    })

    /**
     * Function: reports.sumSplits (filters)
     * Inputs:   a category filter [food]; excludeKinds [] (so the transfer-kind category counts, but linked
     *           transfers still do not); a one-day range; an empty range
     * Expected: only food; the transfer-kind -5000 row appears; the one-day range includes both ends; empty
     *           gives no rows
     */
    it('filters by category, excluded kinds and date range', () => {
      const r = seedMoney()
      expect(
        r.reports.sumSplits('S1', {
          from: '2030-01-01',
          to: '2030-12-31',
          groupBy: 'category',
          categoryIds: ['food'],
        }),
      ).toEqual([row('food', 'expense', null, -3900, 3)])
      const all = r.reports.sumSplits('S1', {
        from: '2030-01-01',
        to: '2030-01-31',
        groupBy: 'category',
        excludeKinds: [],
      })
      expect(all.find((x) => x.categoryId === 'xfer')).toMatchObject({
        cents: -5000,
        kind: 'transfer',
      })
      expect(all.some((x) => x.cents === -9000 || x.cents === 9000)).toBe(false)
      expect(
        r.reports.sumSplits('S1', { from: '2030-01-10', to: '2030-01-10', groupBy: 'category' }),
      ).toEqual([row('food', 'expense', null, -3000, 1)])
      expect(
        r.reports.sumSplits('S1', { from: '2031-01-01', to: '2031-01-31', groupBy: 'category' }),
      ).toEqual([])
    })

    /**
     * Function: reports.sumSplits (cross-Space splits)
     * Inputs:   a -6000 transaction on S2's account split -4000 into S2 and -2000 into S1
     * Expected: S1's total counts only its own -2000; S2's counts its own -4000
     */
    it('counts only the splits that are in the requested Space', () => {
      const r = ledgerWorld()
      r.transactions.create(
        buildTransaction({ id: 'lunch', accountId: 'A2', date: '2030-01-14', amountCents: -6000 }),
        [sp('a', 'S2', -4000), sp('b', 'S1', -2000)],
      )
      expect(
        r.reports.sumSplits('S1', { from: '2030-01-01', to: '2030-01-31', groupBy: 'category' }),
      ).toEqual([row(null, null, null, -2000, 1)])
      expect(
        r.reports.sumSplits('S2', { from: '2030-01-01', to: '2030-01-31', groupBy: 'category' }),
      ).toEqual([row(null, null, null, -4000, 1)])
    })
  })
}
