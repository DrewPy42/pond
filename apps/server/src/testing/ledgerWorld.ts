import type { Actor, Deps } from '../ledger/service.js'
import { seedCategories } from '../ledger/service.js'
import type { Repos } from '../repos/types.js'
import { createFakeRepos } from './fakeRepos.js'
import { buildAccount, buildSpace, buildUser } from './factories.js'

/**
 * Mock data for ledger tests, built directly in fake repositories (no HTTP, no passwords):
 *
 *   Spaces      HOME (personal), BIZ (business); both seeded with starter categories
 *   People      admin (site admin) · ann (editor of HOME) · bob (viewer of HOME) ·
 *               cy (editor of BIZ) · dee (editor of HOME and BIZ)
 *   Accounts    CHECKING and SAVINGS in HOME (USD), CARD in BIZ (USD), EUR in HOME (EUR)
 *
 * Ids are the readable constants below, so a test failure names real things.
 */
export const IDS = {
  HOME: 'space-home',
  BIZ: 'space-biz',
  CHECKING: 'acct-checking',
  SAVINGS: 'acct-savings',
  CARD: 'acct-card',
  EUR: 'acct-eur',
  admin: 'user-admin',
  ann: 'user-ann',
  bob: 'user-bob',
  cy: 'user-cy',
  dee: 'user-dee',
} as const

export interface LedgerWorld {
  deps: Deps
  repos: Repos
  actors: Record<'admin' | 'ann' | 'bob' | 'cy' | 'dee', Actor>
  /** Looks up a seeded category id by Space and name, e.g. category('HOME', 'Groceries'). */
  category(space: 'HOME' | 'BIZ', name: string): string
  advance(ms: number): void
}

export function makeLedgerWorld(): LedgerWorld {
  let t = Date.parse('2030-01-15T12:00:00Z')
  const now = () => new Date(t)
  const repos = createFakeRepos(now)
  let n = 0
  const deps: Deps = { repos, now, newId: () => `gen-${++n}` }

  const user = (id: string, username: string, isAdmin = false) =>
    repos.users.create(buildUser({ id, username, isAdmin }))
  user(IDS.admin, 'admin', true)
  user(IDS.ann, 'ann')
  user(IDS.bob, 'bob')
  user(IDS.cy, 'cy')
  user(IDS.dee, 'dee')

  repos.spaces.create(buildSpace({ id: IDS.HOME, name: 'Home', type: 'personal' }))
  repos.spaces.create(buildSpace({ id: IDS.BIZ, name: 'Biz', type: 'business' }))
  repos.spaces.setMember(IDS.HOME, IDS.ann, 'editor')
  repos.spaces.setMember(IDS.HOME, IDS.bob, 'viewer')
  repos.spaces.setMember(IDS.BIZ, IDS.cy, 'editor')
  repos.spaces.setMember(IDS.HOME, IDS.dee, 'editor')
  repos.spaces.setMember(IDS.BIZ, IDS.dee, 'editor')
  seedCategories(deps, IDS.HOME, 'personal')
  seedCategories(deps, IDS.BIZ, 'business')

  repos.accounts.create(
    buildAccount({ id: IDS.CHECKING, name: 'Checking', primarySpaceId: IDS.HOME }),
  )
  repos.accounts.create(
    buildAccount({ id: IDS.SAVINGS, name: 'Savings', type: 'savings', primarySpaceId: IDS.HOME }),
  )
  repos.accounts.create(
    buildAccount({ id: IDS.CARD, name: 'Biz Card', type: 'credit_card', primarySpaceId: IDS.BIZ }),
  )
  repos.accounts.create(
    buildAccount({ id: IDS.EUR, name: 'Euro Account', currency: 'EUR', primarySpaceId: IDS.HOME }),
  )

  const actor = (key: keyof typeof IDS, isAdmin = false): Actor => ({ id: IDS[key], isAdmin })
  return {
    deps,
    repos,
    actors: {
      admin: actor('admin', true),
      ann: actor('ann'),
      bob: actor('bob'),
      cy: actor('cy'),
      dee: actor('dee'),
    },
    category(space, name) {
      const found = repos.categories.listForSpace(IDS[space]).find((c) => c.name === name)
      if (!found) throw new Error(`no seeded category "${name}" in ${space}`)
      return found.id
    },
    advance: (ms) => void (t += ms),
  }
}
