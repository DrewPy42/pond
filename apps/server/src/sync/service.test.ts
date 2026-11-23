import { describe, expect, it } from 'vitest'
import { LedgerError, createTransaction, updateTransaction } from '../ledger/service'
import { createRule } from '../rules/service'
import { SimpleFinError } from '../simplefin/types'
import { noon, sfAccount, sfTxn } from '../testing/fakeSimpleFin'
import { SPACE, TOKEN, makeSyncWorld } from '../testing/syncWorld'
import {
  FIRST_SYNC_DAYS,
  MANUAL_SYNC_MIN_SECONDS,
  OVERLAP_DAYS,
  assignAccount,
  connectSimpleFin,
  discoverAccounts,
  guessAccountType,
  listConnections,
  revokeConnection,
  syncAll,
  syncConnection,
} from './service'

/**
 * SimpleFIN sync tests. Mock data comes from makeSyncWorld(): an admin, Spaces HOME and BIZ, a
 * scripted FakeSimpleFin "bank", a fixed clock (2030-01-15 12:00 UTC) and UTC time. Everything
 * runs on in-memory fakes: no database, no network.
 */

const DAY = 86_400_000
const codeOf = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    return e instanceof LedgerError ? e.code : `other:${(e as Error).message}`
  }
  return 'no error'
}
const checking = (txs = [sfTxn({ id: 'T1' })]) =>
  sfAccount({ id: 'ACT-1', name: 'Everyday Checking', transactions: txs })

describe('connectSimpleFin (step 1: Setup Token to Access URL)', () => {
  /**
   * Function: connectSimpleFin(deps, actor, { setupToken, label })
   * Inputs:   a valid token; the bank reports checking and savings accounts
   * Expected: the token is claimed once; the connection is active; the Access URL is stored
   *           ENCRYPTED (it never appears in plain text in the repository); both accounts exist
   *           unassigned, hidden and with syncing off, with guessed types
   */
  it('claims the token, stores the Access URL encrypted, and discovers accounts unassigned', async () => {
    const w = makeSyncWorld()
    w.bank.returns([checking([]), sfAccount({ id: 'ACT-2', name: 'High Yield Savings' })])
    const { connection, discovery } = await connectSimpleFin(w.deps, w.admin, {
      setupToken: TOKEN,
      label: 'My bank',
    })
    expect(w.bank.claims).toEqual([TOKEN])
    expect(connection).toMatchObject({ label: 'My bank', status: 'active', lastSyncedAt: null })
    const stored = w.repos.connections.findById(connection.id)!
    expect(stored.accessUrlEnc).toMatch(/^v1:/)
    expect(stored.accessUrlEnc).not.toContain('secret-pass')
    expect(discovery).toMatchObject({ found: 2, added: 2 })
    expect(connection.accounts).toHaveLength(2)
    for (const a of connection.accounts)
      expect(a).toMatchObject({ primarySpaceId: null, hidden: true, syncEnabled: false })
    expect(connection.accounts.map((a) => a.type).sort()).toEqual(['checking', 'savings'])
    expect(w.repos.accounts.findByExternal(connection.id, 'ACT-1')).toMatchObject({
      isManual: false,
      institutionName: 'Test Bank',
    })
  })

  /**
   * Function: connectSimpleFin(...) (secrets stay out of responses and logs)
   * Inputs:   a successful connect
   * Expected: the audit log records "connection.created" with the label, and neither the view
   *           returned to the caller nor any audit entry contains the Access URL or its password
   */
  it('never exposes the Access URL in the response or the audit log', async () => {
    const w = makeSyncWorld()
    w.bank.returns([checking([])])
    const r = await connectSimpleFin(w.deps, w.admin, { setupToken: TOKEN, label: 'My bank' })
    const audit = w.repos.audit.list({ limit: 50 })
    expect(audit.map((a) => a.action)).toContain('connection.created')
    for (const text of [JSON.stringify(r), JSON.stringify(audit)]) {
      expect(text).not.toContain('secret-pass')
      expect(text).not.toContain('bridge.simplefin.test')
      expect(text).not.toContain(TOKEN)
    }
  })

  /**
   * Function: connectSimpleFin(...) (bad token)
   * Inputs:   the bank rejects the claim (403 "token_rejected"); and an unsafe URL error
   * Expected: LedgerError "token_rejected" (400) and "unsafe_url" (400); nothing is stored
   */
  it('stores nothing when the token is rejected', async () => {
    const w = makeSyncWorld()
    w.bank.rejectClaim(new SimpleFinError('token_rejected', 'nope'))
    expect(await codeOf(connectSimpleFin(w.deps, w.admin, { setupToken: TOKEN, label: 'x' }))).toBe(
      'token_rejected',
    )
    w.bank.rejectClaim(new SimpleFinError('unsafe_url', 'private'))
    expect(await codeOf(connectSimpleFin(w.deps, w.admin, { setupToken: TOKEN, label: 'x' }))).toBe(
      'unsafe_url',
    )
    expect(w.repos.connections.list()).toEqual([])
  })

  /**
   * Function: connectSimpleFin(...) (token is single-use)
   * Inputs:   the claim works but listing accounts then fails (network)
   * Expected: the connection is STILL saved (the Access URL must not be lost), active, with the
   *           failure shown in lastError and no discovery result
   */
  it('keeps the connection when discovery fails after a successful claim', async () => {
    const w = makeSyncWorld()
    w.bank.fail(new SimpleFinError('network', 'Could not reach SimpleFIN.'))
    const r = await connectSimpleFin(w.deps, w.admin, { setupToken: TOKEN, label: 'My bank' })
    expect(r.discovery).toBeNull()
    expect(r.connection).toMatchObject({
      status: 'active',
      lastError: 'Could not reach SimpleFIN.',
    })
    expect(w.repos.connections.list()).toHaveLength(1)
  })
})

describe('discoverAccounts and assignAccount (step 2: account discovery and Space assignment)', () => {
  /**
   * Function: discoverAccounts(deps, connectionId)
   * Inputs:   a connection with one known account; the bank now reports it plus a new one and one
   *           in an unsupported (URL) currency
   * Expected: only the new supported account is added (added = 1); the known one is untouched; a
   *           warning names the unsupported one
   */
  it('adds only accounts it has not seen, skipping unsupported currencies', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    w.bank.returns([
      checking([]),
      sfAccount({ id: 'ACT-2', name: 'Savings' }),
      sfAccount({ id: 'ACT-3', name: 'Weird', currency: null }),
    ])
    const r = await discoverAccounts(w.deps, id)
    expect(r.added).toBe(1)
    expect(r.warnings.join(' ')).toContain('unsupported currency')
    expect(w.repos.accounts.listForConnection(id)).toHaveLength(2)
  })

  /**
   * Function: assignAccount(deps, actor, connectionId, accountId, { primarySpaceId })
   * Inputs:   an unassigned bank account assigned to HOME, then unassigned again (no history yet)
   * Expected: assigned: in HOME, visible, syncing on, audited with the Space; unassigned: no
   *           Space, hidden, syncing off
   */
  it('assigning a Space turns syncing on, and unassigning turns it off', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    const accountId = w.assign(id, 'ACT-1', 'HOME')
    expect(w.repos.accounts.findById(accountId)).toMatchObject({
      primarySpaceId: SPACE.HOME,
      hidden: false,
      syncEnabled: true,
    })
    expect(
      w.repos.audit.list({ limit: 20 }).find((a) => a.action === 'connection.account_assigned')
        ?.meta,
    ).toMatchObject({ spaceId: SPACE.HOME })
    assignAccount(w.deps, w.admin, id, accountId, { primarySpaceId: null })
    expect(w.repos.accounts.findById(accountId)).toMatchObject({
      primarySpaceId: null,
      hidden: true,
      syncEnabled: false,
    })
  })

  /**
   * Function: assignAccount(...) (validation)
   * Inputs:   an unknown Space; an account from another connection; and moving an account that
   *           already has transactions
   * Expected: "unknown_space" (400); "not_found" (404); "has_transactions" (409)
   */
  it('rejects unknown Spaces, foreign accounts, and moving an account with history', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking()])
    const accountId = w.repos.accounts.findByExternal(id, 'ACT-1')!.id
    expect(
      await codeOf(() => assignAccount(w.deps, w.admin, id, accountId, { primarySpaceId: 'nope' })),
    ).toBe('unknown_space')
    expect(
      await codeOf(() =>
        assignAccount(w.deps, w.admin, id, 'ghost', { primarySpaceId: SPACE.HOME }),
      ),
    ).toBe('not_found')
    w.assign(id, 'ACT-1', 'HOME')
    await syncConnection(w.deps, id)
    expect(
      await codeOf(() =>
        assignAccount(w.deps, w.admin, id, accountId, { primarySpaceId: SPACE.BIZ }),
      ),
    ).toBe('has_transactions')
  })

  /**
   * Function: guessAccountType(name)
   * Inputs:   typical bank account names
   * Expected: a sensible type for each, and "other" when nothing matches
   */
  it('guesses an account type from its name', () => {
    const g = guessAccountType
    expect([
      g('Visa Signature Card'),
      g('Everyday Checking'),
      g('High Yield Savings'),
      g('Home Mortgage'),
      g('Roth IRA'),
      g('Brokerage Account'),
      g('Mystery'),
    ]).toEqual(['credit_card', 'checking', 'savings', 'loan', 'retirement', 'brokerage', 'other'])
  })
})

describe('syncConnection: upsert and balances (steps 3, 4 and 6)', () => {
  /**
   * Function: syncConnection(deps, connectionId)
   * Inputs:   an assigned HOME account and a bank reporting two transactions (-12.34 and +100.00)
   *           and a balance of 5000.00
   * Expected: both inserted as bank-fed transactions with ONE default split each, in the account's
   *           Space, uncategorized, summing to the amount; today's balance is saved as a "sync"
   *           snapshot; the connection records the sync time and no error
   */
  it('inserts new transactions with one default split and records the balance', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    const acct = w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns([
      sfAccount({
        id: 'ACT-1',
        name: 'Everyday Checking',
        balanceCents: 500000,
        transactions: [
          sfTxn({ id: 'T1', amountCents: -1234, description: 'COFFEE' }),
          sfTxn({ id: 'T2', amountCents: 10000, description: 'PAYROLL' }),
        ],
      }),
    ])
    const s = await syncConnection(w.deps, id)
    expect(s).toMatchObject({ ok: true, accountsSynced: 1, inserted: 2, updated: 0 })
    const t1 = w.repos.transactions.findByExternalId(acct, 'T1')!
    expect(t1.txn).toMatchObject({
      source: 'simplefin',
      amountCents: -1234,
      descriptionRaw: 'COFFEE',
      pending: false,
      status: 'active',
    })
    expect(t1.splits.map((x) => [x.spaceId, x.amountCents, x.categoryId])).toEqual([
      [SPACE.HOME, -1234, null],
    ])
    expect(w.repos.transactions.findInvariantViolations()).toEqual([])
    expect(w.repos.balances.listForAccount(acct)[0]).toMatchObject({
      date: '2030-01-15',
      balanceCents: 500000,
      source: 'sync',
    })
    expect(w.repos.connections.findById(id)).toMatchObject({
      lastSyncedAt: '2030-01-15T12:00:00.000Z',
      lastError: null,
      status: 'active',
    })
  })

  /**
   * Function: syncConnection(...) (idempotence)
   * Inputs:   the same bank response synced three times
   * Expected: the first inserts, the next two change nothing (no duplicates, no updates)
   */
  it('is safe to run repeatedly: syncing the same data adds nothing', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    const acct = w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns([checking()])
    await syncConnection(w.deps, id)
    w.advance(DAY)
    const again = await syncConnection(w.deps, id)
    w.advance(DAY)
    const third = await syncConnection(w.deps, id)
    expect([again.inserted, again.updated, third.inserted, third.updated]).toEqual([0, 0, 0, 0])
    expect(w.repos.transactions.countForAccount(acct)).toBe(1)
  })

  /**
   * Function: syncConnection(...) (what we ask the bank for)
   * Inputs:   a first sync, then another one a day later
   * Expected: first asks for pending transactions from 90 days back; the next asks from 14 days
   *           before the last sync (overlap), pending included
   */
  it('asks for 90 days the first time, then 14 days of overlap', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns([checking([])])
    const before = w.bank.fetches.length
    await syncConnection(w.deps, id)
    const first = w.bank.fetches[before]!.opts
    expect(first.pending).toBe(true)
    expect(first.startDate!.getTime()).toBe(
      Date.parse('2030-01-15T12:00:00Z') - FIRST_SYNC_DAYS * DAY,
    )
    w.advance(DAY)
    await syncConnection(w.deps, id)
    expect(w.bank.fetches.at(-1)!.opts.startDate!.getTime()).toBe(
      Date.parse('2030-01-15T12:00:00Z') - OVERLAP_DAYS * DAY,
    )
  })

  /**
   * Function: syncConnection(...) (accounts not set up for syncing)
   * Inputs:   the bank reports an assigned account, an unassigned one, and a brand-new one
   * Expected: only the assigned account gets transactions; the unassigned is skipped; the new one
   *           is added unassigned (newAccounts = 1) with no transactions
   */
  it('syncs only assigned accounts and quietly adds new ones unassigned', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([]), sfAccount({ id: 'ACT-2', name: 'Savings' })])
    w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns([
      checking(),
      sfAccount({ id: 'ACT-2', name: 'Savings', transactions: [sfTxn({ id: 'S1' })] }),
      sfAccount({ id: 'ACT-3', name: 'New one', transactions: [sfTxn({ id: 'N1' })] }),
    ])
    const s = await syncConnection(w.deps, id)
    expect([s.accountsSynced, s.newAccounts, s.inserted]).toEqual([1, 1, 1])
    const a3 = w.repos.accounts.findByExternal(id, 'ACT-3')!
    expect(a3).toMatchObject({ primarySpaceId: null, syncEnabled: false })
    expect(w.repos.transactions.countForAccount(a3.id)).toBe(0)
  })

  /**
   * Function: syncConnection(...) (changes to a held transaction)
   * Inputs:   a held transaction whose amount later changes on the bank side (one split)
   * Expected: its amount AND its single split follow the new amount, and splits still balance
   */
  it('updates the amount of a one-split transaction and its split together', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    const acct = w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns([checking([sfTxn({ id: 'T1', amountCents: -1000, pending: true })])])
    await syncConnection(w.deps, id)
    w.advance(DAY)
    w.bank.returns([checking([sfTxn({ id: 'T1', amountCents: -1250, pending: false })])])
    const s = await syncConnection(w.deps, id)
    expect(s.updated).toBe(1)
    const t = w.repos.transactions.findByExternalId(acct, 'T1')!
    expect(t.txn).toMatchObject({ amountCents: -1250, pending: false })
    expect(t.splits.map((x) => x.amountCents)).toEqual([-1250])
    expect(w.repos.transactions.findInvariantViolations()).toEqual([])
  })

  /**
   * Function: syncConnection(...) (user edits are protected)
   * Inputs:   a synced transaction the user categorized and split, then the bank re-sends it with a
   *           different amount
   * Expected: the user's splits are NOT overwritten and the amount is not changed; the transaction
   *           is flagged "needs review" and counted in flagged
   */
  it("does not overwrite a user's split with a new bank amount; flags it instead", async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    const acct = w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns([checking([sfTxn({ id: 'T1', amountCents: -1000 })])])
    await syncConnection(w.deps, id)
    const txnId = w.repos.transactions.findByExternalId(acct, 'T1')!.txn.id
    updateTransaction(w.deps, w.admin, SPACE.HOME, txnId, {
      splits: [
        { spaceId: SPACE.HOME, amountCents: -600 },
        { spaceId: SPACE.HOME, amountCents: -400 },
      ],
    })
    w.advance(DAY)
    w.bank.returns([checking([sfTxn({ id: 'T1', amountCents: -1100 })])])
    const s = await syncConnection(w.deps, id)
    const t = w.repos.transactions.findById(txnId)!
    expect(t.txn).toMatchObject({ amountCents: -1000, needsReview: true, userEdited: true })
    expect(t.splits.map((x) => x.amountCents)).toEqual([-600, -400])
    expect(s.flagged).toBe(1)
  })

  /**
   * Function: syncConnection(...) (time zones)
   * Inputs:   a transaction posted 2030-01-10 03:00 UTC, synced with the zone America/New_York
   * Expected: it is dated 2030-01-09 (the household's calendar day), per data-model.md
   */
  it("dates transactions in the household's time zone", async () => {
    const w = makeSyncWorld()
    w.deps.timeZone = 'America/New_York'
    const id = await w.connect([checking([])])
    const acct = w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns([
      checking([
        sfTxn({ id: 'T1', postedEpoch: Math.floor(Date.parse('2030-01-10T03:00:00Z') / 1000) }),
      ]),
    ])
    await syncConnection(w.deps, id)
    expect(w.repos.transactions.findByExternalId(acct, 'T1')!.txn.date).toBe('2030-01-09')
  })
})

describe('syncConnection: pending reconciliation (step 5)', () => {
  const setup = async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    const acct = w.assign(id, 'ACT-1', 'HOME')
    return { w, id, acct }
  }

  /**
   * Function: syncConnection(...) (pending replaced by a posted transaction)
   * Inputs:   a pending coffee (-1000) the user split and categorized; the next sync the bank drops
   *           it and sends a posted coffee with a NEW id, same amount, 2 days later
   * Expected: the posted transaction exists with the pending one's splits and category carried over;
   *           the pending is marked removed and superseded by the posted one; exactly one active
   *           transaction remains
   */
  it('carries categories from a vanished pending to the posted transaction', async () => {
    const { w, id, acct } = await setup()
    w.bank.returns([
      checking([
        sfTxn({
          id: 'PEND-1',
          pending: true,
          amountCents: -1000,
          postedEpoch: 0,
          transactedEpoch: noon('2030-01-10'),
        }),
      ]),
    ])
    await syncConnection(w.deps, id)
    const pendingId = w.repos.transactions.findByExternalId(acct, 'PEND-1')!.txn.id
    const dining = w.repos.categories.listForSpace(SPACE.HOME)[0]?.id ?? null
    w.repos.categories.create({ id: 'cat-x', spaceId: SPACE.HOME, name: 'Coffee', kind: 'expense' })
    updateTransaction(w.deps, w.admin, SPACE.HOME, pendingId, {
      splits: [{ spaceId: SPACE.HOME, amountCents: -1000, categoryId: 'cat-x' }],
    })
    expect(dining).toBeNull() // (no seeded categories in this world; we created one above)

    w.advance(2 * DAY)
    w.bank.returns([
      checking([sfTxn({ id: 'POST-9', amountCents: -1000, postedEpoch: noon('2030-01-12') })]),
    ])
    const s = await syncConnection(w.deps, id)
    expect(s).toMatchObject({ inserted: 1, carriedOver: 1, removed: 0 })
    const posted = w.repos.transactions.findByExternalId(acct, 'POST-9')!
    expect(posted.splits.map((x) => [x.categoryId, x.amountCents])).toEqual([['cat-x', -1000]])
    expect(w.repos.transactions.findById(pendingId)!.txn).toMatchObject({
      status: 'removed',
      supersededBy: posted.txn.id,
    })
    const active = w.repos.transactions.listForSpace(SPACE.HOME, {}, { limit: 50, offset: 0 }).rows
    expect(active.map((r) => r.txn.id)).toEqual([posted.txn.id])
  })

  /**
   * Function: syncConnection(...) (pending that simply vanished)
   * Inputs:   a pending transaction the bank later stops listing, with no posted match
   * Expected: it is marked removed (leaves the lists) and counted in removed
   */
  it('removes a pending transaction that disappears without a replacement', async () => {
    const { w, id, acct } = await setup()
    w.bank.returns([
      checking([
        sfTxn({ id: 'PEND-1', pending: true, amountCents: -777, description: 'GAS STATION' }),
      ]),
    ])
    await syncConnection(w.deps, id)
    w.advance(DAY)
    w.bank.returns([checking([])])
    const s = await syncConnection(w.deps, id)
    expect(s.removed).toBe(1)
    expect(w.repos.transactions.findByExternalId(acct, 'PEND-1')!.txn.status).toBe('removed')
  })

  /**
   * Function: syncConnection(...) (edited pending that vanished)
   * Inputs:   a pending transaction the user edited (payee), which the bank later stops listing
   * Expected: it stays active and is flagged "needs review" instead of being removed
   */
  it('keeps and flags an edited pending transaction that disappears', async () => {
    const { w, id, acct } = await setup()
    w.bank.returns([
      checking([
        sfTxn({ id: 'PEND-1', pending: true, amountCents: -500, description: 'LUNCH SPOT' }),
      ]),
    ])
    await syncConnection(w.deps, id)
    const txnId = w.repos.transactions.findByExternalId(acct, 'PEND-1')!.txn.id
    updateTransaction(w.deps, w.admin, SPACE.HOME, txnId, { payee: 'Lunch Spot' })
    w.advance(DAY)
    w.bank.returns([checking([])])
    const s = await syncConnection(w.deps, id)
    expect(s).toMatchObject({ removed: 0, flagged: 1 })
    expect(w.repos.transactions.findById(txnId)!.txn).toMatchObject({
      status: 'active',
      needsReview: true,
    })
  })

  /**
   * Function: syncConnection(...) (linked transfer on a vanished pending)
   * Inputs:   a pending outgoing transfer leg linked to a deposit on another account; the pending
   *           disappears
   * Expected: the pending is removed and its transfer link is deleted (no dangling link)
   */
  it('unlinks a transfer when its pending side is removed', async () => {
    const { w, id, acct } = await setup()
    const sav = w.repos.accounts.findByExternal(id, 'ACT-1')!.id
    expect(sav).toBe(acct)
    w.bank.returns([
      checking([
        sfTxn({ id: 'PEND-1', pending: true, amountCents: -5000, description: 'TRANSFER OUT' }),
      ]),
    ])
    await syncConnection(w.deps, id)
    const out = w.repos.transactions.findByExternalId(acct, 'PEND-1')!.txn.id
    w.repos.accounts.create({
      id: 'manual-sav',
      name: 'Savings',
      type: 'savings',
      currency: 'USD',
      primarySpaceId: SPACE.HOME,
    })
    createTransaction(w.deps, w.admin, SPACE.HOME, {
      accountId: 'manual-sav',
      date: '2030-01-10',
      amountCents: 5000,
      description: 'In',
    })
    const inId = w.repos.transactions.listForAccountSince('manual-sav', '2030-01-01')[0]!.txn.id
    w.repos.transfers.create({
      id: 'link-1',
      fromTransactionId: out,
      toTransactionId: inId,
      createdBy: 'user',
    })
    w.advance(DAY)
    w.bank.returns([checking([])])
    await syncConnection(w.deps, id)
    expect(w.repos.transfers.findByTransaction(out)).toBeUndefined()
  })
})

describe('syncConnection: errors, limits and safety (step 7)', () => {
  /**
   * Function: syncConnection(...) (bank rejects our access)
   * Inputs:   the bank answers "auth_failed" (403)
   * Expected: ok = false with the message; the connection status becomes "error" with lastError;
   *           no transactions change
   */
  it('marks the connection as errored when access is revoked', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    w.assign(id, 'ACT-1', 'HOME')
    w.bank.fail(new SimpleFinError('auth_failed', 'Access was revoked; connect again.'))
    const s = await syncConnection(w.deps, id)
    expect(s).toMatchObject({ ok: false, error: 'Access was revoked; connect again.' })
    expect(w.repos.connections.findById(id)).toMatchObject({
      status: 'error',
      lastError: 'Access was revoked; connect again.',
    })
  })

  /**
   * Function: syncConnection(...) (temporary failure, then recovery)
   * Inputs:   a network failure, then a good response
   * Expected: after the failure the connection stays active with lastError set and no sync time;
   *           after success lastError is cleared and the sync time is set
   */
  it('records a temporary failure and clears it on the next success', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    w.assign(id, 'ACT-1', 'HOME')
    w.bank.fail(new SimpleFinError('network', 'Could not reach SimpleFIN.'))
    await syncConnection(w.deps, id)
    expect(w.repos.connections.findById(id)).toMatchObject({
      status: 'active',
      lastError: 'Could not reach SimpleFIN.',
      lastSyncedAt: null,
    })
    w.bank.returns([checking([])])
    await syncConnection(w.deps, id)
    expect(w.repos.connections.findById(id)).toMatchObject({
      lastError: null,
      lastSyncedAt: '2030-01-15T12:00:00.000Z',
    })
  })

  /**
   * Function: syncConnection(...) (server messages)
   * Inputs:   the bank returns an account fine plus an errlist "con.auth" message
   * Expected: the account still syncs; the message is kept as a warning in lastError; because it
   *           is an auth problem the connection status becomes "error"
   */
  it('keeps the data and flags the connection when the bank reports an auth problem', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns(
      [checking()],
      [
        {
          code: 'con.auth',
          msg: 'Please sign in to your bank again',
          connId: 'c',
          accountId: null,
        },
      ],
    )
    const s = await syncConnection(w.deps, id)
    expect(s.inserted).toBe(1)
    expect(w.repos.connections.findById(id)).toMatchObject({
      status: 'error',
      lastError: 'Please sign in to your bank again',
    })
  })

  /**
   * Function: syncConnection(...) (account with unreadable data)
   * Inputs:   one account has a transaction with a fraction-of-a-cent amount (problems listed), a
   *           second account is fine
   * Expected: the bad account is skipped entirely (nothing half-synced) with its problem as a
   *           warning; the good one syncs; the sync time does NOT move forward (the skipped
   *           account's data is still owed)
   */
  it('skips an account it cannot read cleanly and does not advance the sync window', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([]), sfAccount({ id: 'ACT-2', name: 'Savings' })])
    w.assign(id, 'ACT-1', 'HOME')
    w.assign(id, 'ACT-2', 'HOME')
    w.bank.returns([
      sfAccount({
        id: 'ACT-1',
        name: 'Everyday Checking',
        transactions: [sfTxn({ id: 'A' })],
        problems: ['Everyday Checking: Amount has a fraction of a cent'],
      }),
      sfAccount({ id: 'ACT-2', name: 'Savings', transactions: [sfTxn({ id: 'B' })] }),
    ])
    const s = await syncConnection(w.deps, id)
    expect([s.accountsSynced, s.inserted]).toEqual([1, 1])
    expect(s.warnings.join(' ')).toContain('fraction of a cent')
    expect(w.repos.connections.findById(id)!.lastSyncedAt).toBeNull()
  })

  /**
   * Function: syncConnection(...) (currency changed)
   * Inputs:   an assigned USD account that the bank now reports in EUR
   * Expected: skipped with a warning; no transactions are written
   */
  it('refuses to mix a changed currency into an account', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    const acct = w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns([
      sfAccount({
        id: 'ACT-1',
        name: 'Everyday Checking',
        currency: 'EUR',
        transactions: [sfTxn({ id: 'A' })],
      }),
    ])
    const s = await syncConnection(w.deps, id)
    expect(s.warnings.join(' ')).toContain('currency changed')
    expect(w.repos.transactions.countForAccount(acct)).toBe(0)
  })

  /**
   * Function: syncConnection(deps, id, { manual: true }) (protecting the request allowance)
   * Inputs:   a manual sync right after a sync; then again after 5 minutes
   * Expected: the first is refused with "sync_too_soon" (429) and a retry time; the later one runs
   */
  it("throttles manual syncs so SimpleFIN's allowance is not burned", async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns([checking([])])
    await syncConnection(w.deps, id)
    expect(await codeOf(syncConnection(w.deps, id, { manual: true }))).toBe('sync_too_soon')
    w.advance((MANUAL_SYNC_MIN_SECONDS + 1) * 1000)
    expect((await syncConnection(w.deps, id, { manual: true })).ok).toBe(true)
  })

  /**
   * Function: user edits on synced transactions
   * Inputs:   the user edits a synced transaction's payee; and tries to type a manual transaction
   *           onto the synced account
   * Expected: userEdited becomes true; manual entry on a bank-fed account gives "synced_account"
   */
  it('marks edited transactions and blocks hand-typed ones on bank-fed accounts', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    const acct = w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns([checking()])
    await syncConnection(w.deps, id)
    const txnId = w.repos.transactions.findByExternalId(acct, 'T1')!.txn.id
    expect(w.repos.transactions.findById(txnId)!.txn.userEdited).toBe(false)
    updateTransaction(w.deps, w.admin, SPACE.HOME, txnId, { payee: 'Corner Cafe' })
    expect(w.repos.transactions.findById(txnId)!.txn.userEdited).toBe(true)
    expect(
      await codeOf(() =>
        createTransaction(w.deps, w.admin, SPACE.HOME, {
          accountId: acct,
          date: '2030-01-10',
          amountCents: -1,
          description: 'x',
        }),
      ),
    ).toBe('synced_account')
  })
})

describe('revokeConnection, listConnections and syncAll', () => {
  /**
   * Function: revokeConnection(deps, actor, connectionId)
   * Inputs:   a connection with a syncing account, revoked
   * Expected: status "revoked", Access URL cleared, account syncing off but history kept, audited;
   *           syncing a revoked connection gives "revoked" (409)
   */
  it('forgets the Access URL and stops syncing but keeps the data', async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    const acct = w.assign(id, 'ACT-1', 'HOME')
    w.bank.returns([checking()])
    await syncConnection(w.deps, id)
    revokeConnection(w.deps, w.admin, id)
    expect(w.repos.connections.findById(id)).toMatchObject({
      status: 'revoked',
      accessUrlEnc: null,
    })
    expect(w.repos.accounts.findById(acct)!.syncEnabled).toBe(false)
    expect(w.repos.transactions.countForAccount(acct)).toBe(1)
    expect(w.repos.audit.list({ limit: 50 }).map((a) => a.action)).toContain('connection.revoked')
    expect(await codeOf(syncConnection(w.deps, id))).toBe('revoked')
  })

  /**
   * Function: listConnections(deps)
   * Inputs:   one connection with two accounts
   * Expected: one view with both accounts and NO access URL field of any kind
   */
  it('lists connections without any secret', async () => {
    const w = makeSyncWorld()
    await w.connect([checking([]), sfAccount({ id: 'ACT-2', name: 'Savings' })])
    const list = listConnections(w.deps)
    expect(list).toHaveLength(1)
    expect(list[0]!.accounts).toHaveLength(2)
    expect(JSON.stringify(list)).not.toMatch(/accessUrl|secret-pass|v1:/)
  })

  /**
   * Function: syncAll(deps) (what the scheduler runs)
   * Inputs:   two live connections (one whose bank fails) and one revoked
   * Expected: results for the two live ones only; the failure is reported in its result and does
   *           not stop the other; the revoked one is skipped
   */
  it('syncs every live connection, isolating failures, skipping revoked ones', async () => {
    const w = makeSyncWorld()
    const a = await w.connect([checking([])])
    w.assign(a, 'ACT-1', 'HOME')
    const b = await w.connect([checking([])])
    const c = await w.connect([checking([])])
    revokeConnection(w.deps, w.admin, c)
    w.bank.returns([checking()])
    const out = await syncAll(w.deps)
    expect(Object.keys(out).sort()).toEqual([a, b].sort())
    expect(out[a]!.ok).toBe(true)
    w.advance(DAY)
    w.bank.fail(new SimpleFinError('network', 'down'))
    const failed = await syncAll(w.deps)
    expect(failed[a]).toMatchObject({ ok: false, error: 'down' })
    expect(failed[b]).toMatchObject({ ok: false })
  })
})

describe('syncConnection: rules on new bank transactions (M4)', () => {
  /**
   * Function: syncConnection(...) with a Space rule
   * Inputs:   a HOME rule "description contains COFFEE -> category Coffee, payee Cafe"; a sync bringing a
   *           COFFEE SHOP purchase and an unrelated one
   * Expected: the coffee transaction is categorized and gets the payee (ruled = 1); the other is untouched;
   *           neither is marked as edited by a person
   */
  it("categorizes new transactions with the Space's rules", async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    const acct = w.assign(id, 'ACT-1', 'HOME')
    w.repos.categories.create({
      id: 'cat-coffee',
      spaceId: SPACE.HOME,
      name: 'Coffee',
      kind: 'expense',
    })
    createRule(w.deps, w.admin, SPACE.HOME, {
      name: 'Coffee',
      priority: 1,
      enabled: true,
      conditions: [{ type: 'text', field: 'description', op: 'contains', value: 'coffee' }],
      actions: [
        { type: 'set_category', categoryId: 'cat-coffee' },
        { type: 'set_payee', payee: 'Cafe' },
      ],
    })
    w.bank.returns([
      checking([
        sfTxn({ id: 'T1', description: 'COFFEE SHOP #4' }),
        sfTxn({ id: 'T2', description: 'HARDWARE', amountCents: -900 }),
      ]),
    ])
    const s = await syncConnection(w.deps, id)
    expect(s).toMatchObject({ inserted: 2, ruled: 1 })
    const t1 = w.repos.transactions.findByExternalId(acct, 'T1')!
    expect(t1.txn).toMatchObject({ payee: 'Cafe', userEdited: false })
    expect(t1.splits[0]!.categoryId).toBe('cat-coffee')
    expect(w.repos.transactions.findByExternalId(acct, 'T2')!.splits[0]!.categoryId).toBeNull()
  })
  /**
   * Function: syncConnection(...) (rules do not override carried-over categories)
   * Inputs:   a pending coffee the user categorized by hand as "Other"; the posted version arrives with a new
   *           id, while a rule would say "Coffee"
   * Expected: the posted transaction keeps the user's category (it inherited it), and the rule is not re-run on it
   */
  it("does not re-categorize a posted transaction that inherited a person's choice", async () => {
    const w = makeSyncWorld()
    const id = await w.connect([checking([])])
    const acct = w.assign(id, 'ACT-1', 'HOME')
    w.repos.categories.create({
      id: 'cat-coffee',
      spaceId: SPACE.HOME,
      name: 'Coffee',
      kind: 'expense',
    })
    w.repos.categories.create({
      id: 'cat-other',
      spaceId: SPACE.HOME,
      name: 'Other',
      kind: 'expense',
    })
    w.bank.returns([
      checking([
        sfTxn({
          id: 'PEND',
          pending: true,
          postedEpoch: 0,
          transactedEpoch: noon('2030-01-10'),
          description: 'COFFEE SHOP',
          amountCents: -500,
        }),
      ]),
    ])
    await syncConnection(w.deps, id)
    const pendingId = w.repos.transactions.findByExternalId(acct, 'PEND')!.txn.id
    updateTransaction(w.deps, w.admin, SPACE.HOME, pendingId, {
      splits: [{ spaceId: SPACE.HOME, amountCents: -500, categoryId: 'cat-other' }],
    })
    createRule(w.deps, w.admin, SPACE.HOME, {
      name: 'Coffee',
      priority: 1,
      enabled: true,
      conditions: [{ type: 'text', field: 'description', op: 'contains', value: 'coffee' }],
      actions: [{ type: 'set_category', categoryId: 'cat-coffee' }],
    })
    w.advance(2 * DAY)
    w.bank.returns([
      checking([
        sfTxn({
          id: 'POST',
          description: 'COFFEE SHOP',
          amountCents: -500,
          postedEpoch: noon('2030-01-12'),
        }),
      ]),
    ])
    const s = await syncConnection(w.deps, id)
    expect(s).toMatchObject({ carriedOver: 1, ruled: 0 })
    expect(w.repos.transactions.findByExternalId(acct, 'POST')!.splits[0]!.categoryId).toBe(
      'cat-other',
    )
  })
})
