import type { AuditEntryView } from '@pond/shared'
import { describe, expect, it } from 'vitest'
import { ACTIONS, APP_ACTIONS, auditLine, type AuditNames } from './auditText'

const names: AuditNames = {
  users: new Map([
    ['u1', 'Ann'],
    ['u2', 'Sam'],
  ]),
  spaces: new Map([['s1', 'Home']]),
  apps: new Map([['business', 'Business Manager']]),
}
const entry = (over: Partial<AuditEntryView>): AuditEntryView => ({
  id: 'e1',
  at: '2030-01-01T00:00:00.000Z',
  actorType: 'user',
  actorId: 'u1',
  action: 'auth.login',
  targetType: null,
  targetId: null,
  spaceId: null,
  meta: null,
  ...over,
})

describe('auditLine(entry, names)', () => {
  /**
   * Inputs:   Ann giving Sam the viewer role in Home
   * Expected: plain words, Ann as who did it, and Sam, the role and the Space as details; no ids
   */
  it('names the people and the Space', () => {
    const line = auditLine(
      entry({
        action: 'space.member_added',
        targetType: 'user',
        targetId: 'u2',
        spaceId: 's1',
        meta: { role: 'viewer' },
      }),
      names,
    )
    expect(line).toEqual({
      what: 'Added someone to a Space',
      who: 'Ann',
      details: 'Sam · as viewer · Space: Home',
    })
  })

  /**
   * Inputs:   a failed sign-in where the "username" typed was really a password, and one for a
   *           real account
   * Expected: the typed text appears nowhere; the first says the username doesn't exist, the
   *           second names the account; both show the address
   */
  it('never shows what was typed as a username', () => {
    const typed = 'my-actual-password-123'
    const unknown = auditLine(
      entry({
        actorType: 'system',
        actorId: null,
        action: 'auth.login_failed',
        targetType: 'user',
        meta: { username: typed, ip: '192.168.1.9' },
      }),
      names,
    )
    expect(JSON.stringify(unknown)).not.toContain(typed)
    expect(unknown).toEqual({
      what: 'Sign-in failed',
      who: 'Not signed in',
      details: "for a username that doesn't exist · from 192.168.1.9",
    })
    const known = auditLine(
      entry({
        actorType: 'system',
        actorId: null,
        action: 'auth.lockout',
        targetType: 'user',
        targetId: 'u2',
        meta: { username: typed },
      }),
      names,
    )
    expect(known.details).toBe('for Sam')
  })

  /**
   * Inputs:   entries carrying extra details the screen has no use for
   * Expected: none of them appear; only chosen details are shown
   */
  it('shows only chosen details', () => {
    for (const action of ['auth.login', 'space.created', 'backup.created', 'something.new']) {
      const line = auditLine(entry({ action, meta: { surprise: 'zzz-hidden', bytes: 5 } }), names)
      expect(JSON.stringify(line)).not.toContain('zzz-hidden')
    }
  })

  /**
   * Inputs:   an app's entry, an unknown action, and a removed user and Space
   * Expected: the app's words and name; an unknown action shows its code, so nothing is hidden;
   *           what no longer exists is said plainly
   */
  it('copes with apps, new actions and removed things', () => {
    const app = auditLine(
      entry({
        actorType: 'lilypad',
        actorId: 'business',
        action: 'lilypad.business.taxid.revealed',
        spaceId: 's1',
      }),
      names,
    )
    expect(app).toEqual({
      what: 'Viewed a full tax ID',
      who: 'Business Manager', // named once, not repeated in the details
      details: 'Space: Home',
    })
    const odd = auditLine(entry({ action: 'something.new', actorId: 'gone', spaceId: 'x' }), names)
    expect(odd).toEqual({
      what: 'something.new',
      who: 'A removed user',
      details: 'Space: one that was deleted',
    })
  })

  /**
   * Inputs:   a password reset run on the computer, and a scheduled backup
   * Expected: who did it is the computer, and Pond; the details say what was affected
   */
  it('says when nobody was signed in', () => {
    expect(
      auditLine(
        entry({
          actorType: 'system',
          actorId: null,
          action: 'auth.password_reset_from_console',
          targetType: 'user',
          targetId: 'u2',
          meta: { removedTwoFactor: true },
        }),
        names,
      ),
    ).toMatchObject({
      who: 'From the computer running Pond',
      details: 'for Sam · two-step sign-in turned off',
    })
    expect(
      auditLine(
        entry({
          actorType: 'system',
          actorId: null,
          action: 'backup.created',
          meta: { destination: 'folder', trigger: 'schedule' },
        }),
        names,
      ),
    ).toMatchObject({ who: 'Pond', details: 'to the backup folder · on schedule' })
  })
})

describe('every recorded action has plain words', () => {
  const sources = (found: Record<string, unknown>) =>
    Object.entries(found as Record<string, string>)
      .filter(([path]) => !/\.test\.ts$|\/testing\/|\/db\//.test(path))
      .map(([, source]) => source)
      .join('\n')
  const server = sources(
    import.meta.glob('../../../../server/src/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )
  const apps = sources(
    import.meta.glob('../../../../../lilypads/*/src/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )

  /**
   * Inputs:   every quoted action name in the server's source (settings keys and the backup
   *           event aside)
   * Expected: each has words in ACTIONS. This fails when someone records a new action
   */
  it('covers the server', () => {
    const notActions = new Set([
      'backup.instanceId',
      'backup.passphrase',
      'backup.schedule',
      'backup.folderEnabled',
      'backup.keep',
      'backup.status',
      'backup.before',
    ])
    const found = new Set(
      [
        ...server.matchAll(
          /'((?:auth|setup|user|space|backup|import|connection|lilypad)\.[a-zA-Z_]+)'/g,
        ),
      ]
        .map((m) => m[1]!)
        .filter((a) => !notActions.has(a)),
    )
    expect(found.size).toBeGreaterThan(30) // the search is still finding them
    expect([...found].filter((a) => !ACTIONS[a])).toEqual([])
  })

  /**
   * Inputs:   every `action: '...'` in the apps that come with Pond
   * Expected: each has words in APP_ACTIONS
   */
  it("covers Pond's apps", () => {
    const found = new Set([...apps.matchAll(/action: '([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!))
    expect(found.size).toBeGreaterThan(10)
    expect([...found].filter((a) => !APP_ACTIONS[a])).toEqual([])
  })
})
