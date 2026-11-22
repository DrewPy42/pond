import { describe, expect, it } from 'vitest'
import { DuplicateError, MissingParentError, type AuditRecord, type Repos } from '../repos/types.js'
import { buildSpace, buildUser } from './factories.js'

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
}
