import { randomBytes } from 'node:crypto'
import { createCrypto } from '../crypto/index.js'
import type { Actor } from '../ledger/service.js'
import type { Repos } from '../repos/types.js'
import type { SimpleFinAccount } from '../simplefin/types.js'
import { assignAccount, connectSimpleFin, type SyncDeps } from '../sync/service.js'
import { createFakeRepos } from './fakeRepos.js'
import { FakeSimpleFin, sfAccount } from './fakeSimpleFin.js'
import { buildSpace, buildUser } from './factories.js'

/**
 * Mock data for sync tests, all in fakes (no database, no network):
 *   admin   - the site admin who connects banks
 *   Spaces  - HOME (personal) and BIZ (business)
 *   bank    - a FakeSimpleFin you script with `.returns([...])`
 *   clock   - starts 2030-01-15 12:00 UTC; `advance(ms)` moves it
 * The time zone is UTC so calendar days are predictable.
 */
export interface SyncWorld {
  deps: SyncDeps
  repos: Repos
  bank: FakeSimpleFin
  admin: Actor
  advance(ms: number): void
  /** Connects with a token and a bank that reports `accounts`; returns the connection id. */
  connect(accounts: SimpleFinAccount[]): Promise<string>
  /** Assigns a bank account (by its SimpleFIN id) to a Space and turns syncing on. */
  assign(connectionId: string, bankAccountId: string, space: 'HOME' | 'BIZ'): string
}

export const SPACE = { HOME: 'space-home', BIZ: 'space-biz' } as const
export const TOKEN = Buffer.from('https://bridge.simplefin.org/simplefin/claim/abc123').toString(
  'base64',
)

export function makeSyncWorld(): SyncWorld {
  let t = Date.parse('2030-01-15T12:00:00Z')
  const now = () => new Date(t)
  const repos = createFakeRepos(now)
  let n = 0
  const bank = new FakeSimpleFin()
  const deps: SyncDeps = {
    repos,
    now,
    newId: () => `gen-${++n}`,
    crypto: createCrypto(randomBytes(32)),
    client: bank,
    timeZone: 'UTC',
  }
  repos.users.create(buildUser({ id: 'user-admin', username: 'admin', isAdmin: true }))
  repos.spaces.create(buildSpace({ id: SPACE.HOME, name: 'Home' }))
  repos.spaces.create(buildSpace({ id: SPACE.BIZ, name: 'Biz', type: 'business' }))
  const admin: Actor = { id: 'user-admin', isAdmin: true }

  return {
    deps,
    repos,
    bank,
    admin,
    advance: (ms) => void (t += ms),
    async connect(accounts) {
      bank.returns(accounts)
      const r = await connectSimpleFin(deps, admin, { setupToken: TOKEN, label: 'My bank' })
      return r.connection.id
    },
    assign(connectionId, bankAccountId, space) {
      const a = repos.accounts.findByExternal(connectionId, bankAccountId)!
      assignAccount(deps, admin, connectionId, a.id, { primarySpaceId: SPACE[space] })
      return a.id
    },
  }
}

export { sfAccount }
