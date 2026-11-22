import { describe, expect, it } from 'vitest'
import {
  LedgerError,
  createAccount,
  createCategory,
  createTransaction,
  getTransaction,
  linkTransfer,
  listAccounts,
  listTransactions,
  removeTransaction,
  seedMissingCategories,
  setBalance,
  unlinkTransfer,
  updateAccount,
  updateCategory,
  updateTransaction,
} from './service'
import { IDS, makeLedgerWorld } from '../testing/ledgerWorld'

/**
 * Ledger service tests. Mock data comes from makeLedgerWorld() (see testing/ledgerWorld.ts for
 * the cast: spaces HOME/BIZ, people ann/bob/cy/dee/admin, accounts CHECKING/SAVINGS/CARD/EUR).
 * Everything runs on in-memory fake repositories; there is no database.
 */

const q = { limit: 50, offset: 0 }

/** Runs `fn` and returns the LedgerError code it throws (or "no error"). */
const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return e instanceof LedgerError ? e.code : `other:${(e as Error).message}`
  }
  return 'no error'
}

describe('createAccount / listAccounts / updateAccount / setBalance', () => {
  /**
   * Function: createAccount(deps, spaceId, input), listAccounts(deps, spaceId)
   * Inputs:   a "Rainy Day" savings account in HOME with an opening balance of 250000 cents
   * Expected: a manual account in HOME with the Space's currency, whose balance is 250000 dated
   *           today; it appears in HOME's list and not in BIZ's
   */
  it('creates a manual account with an opening balance', () => {
    const w = makeLedgerWorld()
    const a = createAccount(w.deps, IDS.HOME, {
      name: 'Rainy Day',
      type: 'savings',
      includeInNetWorth: true,
      openingBalanceCents: 250000,
    })
    expect(a).toMatchObject({
      name: 'Rainy Day',
      isManual: true,
      currency: 'USD',
      balanceCents: 250000,
      balanceDate: '2030-01-15',
    })
    expect(listAccounts(w.deps, IDS.HOME).map((x) => x.name)).toContain('Rainy Day')
    expect(listAccounts(w.deps, IDS.BIZ).map((x) => x.name)).not.toContain('Rainy Day')
  })

  /**
   * Function: updateAccount(deps, spaceId, accountId, input)
   * Inputs:   rename CHECKING, then archive it; and an attempt to update CHECKING from BIZ
   * Expected: the name changes; archived accounts leave the default list but show with
   *           includeArchived; updating through the wrong Space gives "not_found"
   */
  it('renames, archives, and refuses cross-Space edits', () => {
    const w = makeLedgerWorld()
    updateAccount(w.deps, IDS.HOME, IDS.CHECKING, { name: 'Everyday' })
    expect(listAccounts(w.deps, IDS.HOME).map((x) => x.name)).toContain('Everyday')
    updateAccount(w.deps, IDS.HOME, IDS.CHECKING, { archived: true })
    expect(listAccounts(w.deps, IDS.HOME).map((x) => x.name)).not.toContain('Everyday')
    expect(listAccounts(w.deps, IDS.HOME, true).find((x) => x.id === IDS.CHECKING)?.archived).toBe(
      true,
    )
    expect(codeOf(() => updateAccount(w.deps, IDS.BIZ, IDS.CHECKING, { name: 'Hijack' }))).toBe(
      'not_found',
    )
  })

  /**
   * Function: setBalance(deps, spaceId, accountId, date, input)
   * Inputs:   CHECKING balance 100000 on Jan 1, then a correction to 110000 for Jan 1, then
   *           130000 on Jan 5
   * Expected: one snapshot per day (the correction replaces); the account's current balance is
   *           the latest day (130000 on Jan 5)
   */
  it('records one manual balance per day and reports the latest', () => {
    const w = makeLedgerWorld()
    setBalance(w.deps, IDS.HOME, IDS.CHECKING, '2030-01-01', { balanceCents: 100000 })
    setBalance(w.deps, IDS.HOME, IDS.CHECKING, '2030-01-01', { balanceCents: 110000 })
    setBalance(w.deps, IDS.HOME, IDS.CHECKING, '2030-01-05', { balanceCents: 130000 })
    expect(
      w.repos.balances.listForAccount(IDS.CHECKING).map((b) => [b.date, b.balanceCents]),
    ).toEqual([
      ['2030-01-05', 130000],
      ['2030-01-01', 110000],
    ])
    expect(listAccounts(w.deps, IDS.HOME).find((a) => a.id === IDS.CHECKING)).toMatchObject({
      balanceCents: 130000,
      balanceDate: '2030-01-05',
    })
  })
})

describe('categories: seedCategories, seedMissingCategories, createCategory, updateCategory', () => {
  /**
   * Function: seedCategories(deps, spaceId, type)
   * Inputs:   the world's HOME (personal) and BIZ (business) Spaces
   * Expected: HOME has Groceries and no tax lines; BIZ has Advertising on "Schedule C, Line 8"
   */
  it('gives personal and business Spaces their own starter lists', () => {
    const w = makeLedgerWorld()
    const home = w.repos.categories.listForSpace(IDS.HOME)
    const biz = w.repos.categories.listForSpace(IDS.BIZ)
    expect(home.map((c) => c.name)).toContain('Groceries')
    expect(home.every((c) => c.taxLine === null)).toBe(true)
    expect(biz.find((c) => c.name === 'Advertising')?.taxLine).toBe('Schedule C, Line 8')
  })

  /**
   * Function: seedMissingCategories(deps)
   * Inputs:   a new Space with no categories, run twice
   * Expected: the first run seeds it (returns 1) and the second does nothing (returns 0)
   */
  it('seeds Spaces that never had categories, once', () => {
    const w = makeLedgerWorld()
    w.repos.spaces.create({ id: 'space-new', name: 'New', type: 'personal', currency: 'USD' })
    expect(seedMissingCategories(w.deps)).toBe(1)
    expect(seedMissingCategories(w.deps)).toBe(0)
    expect(w.repos.categories.listForSpace('space-new').length).toBeGreaterThan(5)
  })

  /**
   * Function: createCategory / updateCategory
   * Inputs:   a custom "Pet Care" category in HOME; rename it; archive it; try to edit a BIZ
   *           category through HOME
   * Expected: created in HOME; renamed; archived ones vanish from the default list; the cross-
   *           Space edit gives "not_found"
   */
  it('adds, renames and archives categories within one Space', () => {
    const w = makeLedgerWorld()
    const c = createCategory(w.deps, IDS.HOME, { name: 'Pet Care', kind: 'expense' })
    expect(updateCategory(w.deps, IDS.HOME, c.id, { name: 'Pets' }).name).toBe('Pets')
    updateCategory(w.deps, IDS.HOME, c.id, { archived: true })
    expect(w.repos.categories.listForSpace(IDS.HOME).map((x) => x.name)).not.toContain('Pets')
    expect(
      codeOf(() =>
        updateCategory(w.deps, IDS.HOME, w.category('BIZ', 'Advertising'), { name: 'x' }),
      ),
    ).toBe('not_found')
  })
})

describe('createTransaction (splits and the invariant)', () => {
  /**
   * Function: createTransaction(deps, actor, spaceId, input)
   * Inputs:   ann adds -4250 "Market" on CHECKING with no splits given
   * Expected: one default split in HOME for -4250, uncategorized; the transaction is manual
   */
  it('gives a plain transaction one default split for the full amount', () => {
    const w = makeLedgerWorld()
    const t = createTransaction(w.deps, w.actors.ann, IDS.HOME, {
      accountId: IDS.CHECKING,
      date: '2030-01-14',
      amountCents: -4250,
      description: 'Market',
    })
    expect(t).toMatchObject({ kind: 'full', amountCents: -4250, source: 'manual' })
    expect(
      t.kind === 'full' && t.splits.map((s) => [s.spaceId, s.amountCents, s.categoryId]),
    ).toEqual([[IDS.HOME, -4250, null]])
  })

  /**
   * Function: createTransaction(...) with explicit splits
   * Inputs:   -10000 split -6000 Groceries and -4000 uncategorized
   * Expected: both splits stored with their categories, summing to the transaction
   */
  it('stores several splits with categories', () => {
    const w = makeLedgerWorld()
    const groceries = w.category('HOME', 'Groceries')
    const t = createTransaction(w.deps, w.actors.ann, IDS.HOME, {
      accountId: IDS.CHECKING,
      date: '2030-01-14',
      amountCents: -10000,
      description: 'Big shop',
      splits: [
        { spaceId: IDS.HOME, amountCents: -6000, categoryId: groceries },
        { spaceId: IDS.HOME, amountCents: -4000 },
      ],
    })
    expect(t.kind === 'full' && t.splits.map((s) => [s.amountCents, s.categoryId])).toEqual([
      [-6000, groceries],
      [-4000, null],
    ])
  })

  /**
   * Function: createTransaction(...) (split invariant, CLAUDE.md rule 3)
   * Inputs:   -10000 with splits -6000 and -3999 (one cent short)
   * Expected: LedgerError "splits_do_not_balance" and no transaction is stored
   */
  it('refuses splits that do not add up, storing nothing', () => {
    const w = makeLedgerWorld()
    const bad = () =>
      createTransaction(w.deps, w.actors.ann, IDS.HOME, {
        accountId: IDS.CHECKING,
        date: '2030-01-14',
        amountCents: -10000,
        description: 'Oops',
        splits: [
          { spaceId: IDS.HOME, amountCents: -6000 },
          { spaceId: IDS.HOME, amountCents: -3999 },
        ],
      })
    expect(codeOf(bad)).toBe('splits_do_not_balance')
    expect(listTransactions(w.deps, IDS.HOME, q).total).toBe(0)
  })

  /**
   * Function: createTransaction(...) (category rules)
   * Inputs:   a split using BIZ's "Advertising" category inside HOME; and an archived HOME category
   * Expected: "invalid_category" both times (categories belong to the split's own Space and must
   *           be active)
   */
  it("requires an active category from the split's own Space", () => {
    const w = makeLedgerWorld()
    const base = {
      accountId: IDS.CHECKING,
      date: '2030-01-14',
      amountCents: -1000,
      description: 'x',
    }
    const foreign = w.category('BIZ', 'Advertising')
    expect(
      codeOf(() =>
        createTransaction(w.deps, w.actors.ann, IDS.HOME, {
          ...base,
          splits: [{ spaceId: IDS.HOME, amountCents: -1000, categoryId: foreign }],
        }),
      ),
    ).toBe('invalid_category')
    const dining = w.category('HOME', 'Dining Out')
    updateCategory(w.deps, IDS.HOME, dining, { archived: true })
    expect(
      codeOf(() =>
        createTransaction(w.deps, w.actors.ann, IDS.HOME, {
          ...base,
          splits: [{ spaceId: IDS.HOME, amountCents: -1000, categoryId: dining }],
        }),
      ),
    ).toBe('invalid_category')
  })

  /**
   * Function: createTransaction(...) (cross-Space splits and permissions)
   * Inputs:   a -6000 lunch on HOME's CHECKING split -4000 HOME / -2000 BIZ, by dee (editor of
   *           both) and then by ann (editor of HOME only)
   * Expected: dee succeeds; ann gets "forbidden_space" (she can't place money in a Space she
   *           can't edit); a split in a Space that doesn't exist gives "unknown_space"
   */
  it('lets an actor split into another Space only if they can edit it', () => {
    const w = makeLedgerWorld()
    const input = {
      accountId: IDS.CHECKING,
      date: '2030-01-14',
      amountCents: -6000,
      description: 'Lunch',
      splits: [
        { spaceId: IDS.HOME, amountCents: -4000 },
        { spaceId: IDS.BIZ, amountCents: -2000 },
      ],
    }
    expect(createTransaction(w.deps, w.actors.dee, IDS.HOME, input).kind).toBe('full')
    expect(codeOf(() => createTransaction(w.deps, w.actors.ann, IDS.HOME, input))).toBe(
      'forbidden_space',
    )
    expect(
      codeOf(() =>
        createTransaction(w.deps, w.actors.dee, IDS.HOME, {
          ...input,
          splits: [{ spaceId: 'nope', amountCents: -6000 }],
        }),
      ),
    ).toBe('unknown_space')
  })

  /**
   * Function: createTransaction(...) (account scoping)
   * Inputs:   ann adds a transaction in HOME on BIZ's CARD account
   * Expected: "not_found" (an account outside this Space doesn't exist as far as she can tell)
   */
  it('refuses an account that belongs to another Space', () => {
    const w = makeLedgerWorld()
    expect(
      codeOf(() =>
        createTransaction(w.deps, w.actors.ann, IDS.HOME, {
          accountId: IDS.CARD,
          date: '2030-01-14',
          amountCents: -1,
          description: 'x',
        }),
      ),
    ).toBe('not_found')
  })
})

describe('updateTransaction', () => {
  const add = (w: ReturnType<typeof makeLedgerWorld>, amountCents = -1000) =>
    createTransaction(w.deps, w.actors.ann, IDS.HOME, {
      accountId: IDS.CHECKING,
      date: '2030-01-14',
      amountCents,
      description: 'Thing',
    }).id

  /**
   * Function: updateTransaction(deps, actor, spaceId, txnId, input) (simple fields)
   * Inputs:   change payee, memo, description, pending and private
   * Expected: those change; the amount and the splits are untouched
   */
  it('edits descriptive fields without touching money', () => {
    const w = makeLedgerWorld()
    const id = add(w)
    const t = updateTransaction(w.deps, w.actors.ann, IDS.HOME, id, {
      payee: 'Acme',
      memo: 'n',
      description: 'Renamed',
      pending: true,
      private: true,
    })
    expect(t).toMatchObject({
      payee: 'Acme',
      memo: 'n',
      descriptionRaw: 'Renamed',
      pending: true,
      private: true,
      amountCents: -1000,
    })
  })

  /**
   * Function: updateTransaction(...) (amount change)
   * Inputs:   change a one-split -1000 transaction to -2500 without sending splits; then split
   *           it two ways and change the amount again without splits
   * Expected: the single split follows the new amount (-2500); with two splits it refuses with
   *           "splits_required" and nothing changes
   */
  it('moves a lone split with the amount, but demands splits when there are several', () => {
    const w = makeLedgerWorld()
    const id = add(w)
    const t = updateTransaction(w.deps, w.actors.ann, IDS.HOME, id, { amountCents: -2500 })
    expect(t.kind === 'full' && t.splits.map((s) => s.amountCents)).toEqual([-2500])
    updateTransaction(w.deps, w.actors.ann, IDS.HOME, id, {
      splits: [
        { spaceId: IDS.HOME, amountCents: -1500 },
        { spaceId: IDS.HOME, amountCents: -1000 },
      ],
    })
    expect(
      codeOf(() => updateTransaction(w.deps, w.actors.ann, IDS.HOME, id, { amountCents: -3000 })),
    ).toBe('splits_required')
    expect(getTransaction(w.deps, IDS.HOME, id).transaction).toMatchObject({ amountCents: -2500 })
  })

  /**
   * Function: updateTransaction(...) (replacing splits)
   * Inputs:   a -1000 transaction given splits [-1000] then [-700, -299]
   * Expected: the balanced replacement is stored; the unbalanced one gives
   *           "splits_do_not_balance" and the previous splits stay
   */
  it('replaces splits only when the new ones balance', () => {
    const w = makeLedgerWorld()
    const id = add(w)
    expect(
      codeOf(() =>
        updateTransaction(w.deps, w.actors.ann, IDS.HOME, id, {
          splits: [
            { spaceId: IDS.HOME, amountCents: -700 },
            { spaceId: IDS.HOME, amountCents: -299 },
          ],
        }),
      ),
    ).toBe('splits_do_not_balance')
    const t = updateTransaction(w.deps, w.actors.ann, IDS.HOME, id, {
      splits: [
        { spaceId: IDS.HOME, amountCents: -700 },
        { spaceId: IDS.HOME, amountCents: -300 },
      ],
    })
    expect(t.kind === 'full' && t.splits.map((s) => s.amountCents)).toEqual([-700, -300])
  })

  /**
   * Function: updateTransaction(...) (who can edit)
   * Inputs:   cy (BIZ only) editing a HOME transaction; and dee splitting a HOME transaction
   *           into BIZ, then cy trying to edit that transaction from BIZ
   * Expected: cy gets "not_found" on a transaction he can't see; once BIZ holds a split, cy can
   *           see it but editing is "forbidden" (it isn't on his account)
   */
  it('lets only the owning Space edit, even if another Space can see it', () => {
    const w = makeLedgerWorld()
    const id = add(w)
    expect(codeOf(() => updateTransaction(w.deps, w.actors.cy, IDS.BIZ, id, { payee: 'x' }))).toBe(
      'not_found',
    )
    updateTransaction(w.deps, w.actors.dee, IDS.HOME, id, {
      splits: [
        { spaceId: IDS.HOME, amountCents: -600 },
        { spaceId: IDS.BIZ, amountCents: -400 },
      ],
    })
    expect(codeOf(() => updateTransaction(w.deps, w.actors.cy, IDS.BIZ, id, { payee: 'x' }))).toBe(
      'forbidden',
    )
  })
})

describe('removeTransaction', () => {
  /**
   * Function: removeTransaction(deps, spaceId, txnId)
   * Inputs:   a manual transaction; then a bank-sourced one
   * Expected: the manual one is soft-deleted (leaves the list, row kept with status "removed");
   *           the bank-sourced one gives "not_manual"
   */
  it('soft-deletes manual transactions only', () => {
    const w = makeLedgerWorld()
    const id = createTransaction(w.deps, w.actors.ann, IDS.HOME, {
      accountId: IDS.CHECKING,
      date: '2030-01-14',
      amountCents: -1000,
      description: 'x',
    }).id
    removeTransaction(w.deps, IDS.HOME, id)
    expect(listTransactions(w.deps, IDS.HOME, q).total).toBe(0)
    expect(w.repos.transactions.findById(id)?.txn.status).toBe('removed')

    w.repos.transactions.create(
      {
        id: 'bank-1',
        accountId: IDS.CHECKING,
        source: 'simplefin',
        externalId: 'x1',
        date: '2030-01-14',
        amountCents: -500,
        descriptionRaw: 'Bank',
      },
      [{ id: 'bs', spaceId: IDS.HOME, amountCents: -500 }],
    )
    expect(codeOf(() => removeTransaction(w.deps, IDS.HOME, 'bank-1'))).toBe('not_manual')
  })
})

describe('listTransactions / getTransaction (cross-Space privacy applied)', () => {
  const lunch = (w: ReturnType<typeof makeLedgerWorld>, priv: boolean) => {
    const t = createTransaction(w.deps, w.actors.dee, IDS.HOME, {
      accountId: IDS.CHECKING,
      date: '2030-01-14',
      amountCents: -6000,
      description: 'Team lunch',
      payee: 'Cafe',
      memo: 'private note',
      splits: [
        { spaceId: IDS.HOME, amountCents: -4000 },
        { spaceId: IDS.BIZ, amountCents: -2000, memo: 'client' },
      ],
    })
    if (priv) updateTransaction(w.deps, w.actors.dee, IDS.HOME, t.id, { private: true })
    return t.id
  }

  /**
   * Function: listTransactions(deps, spaceId, query)
   * Inputs:   a -6000 lunch split HOME -4000 / BIZ -2000, listed from HOME and from BIZ
   * Expected: HOME sees the full view; BIZ sees a shared view with only its -2000 split, the
   *           account name, total -6000 and "other Spaces" -4000, but not the memo
   */
  it('shows each Space only what it may see', () => {
    const w = makeLedgerWorld()
    lunch(w, false)
    expect(listTransactions(w.deps, IDS.HOME, q).transactions[0]).toMatchObject({
      kind: 'full',
      amountCents: -6000,
    })
    const shared = listTransactions(w.deps, IDS.BIZ, q).transactions[0]!
    expect(shared).toMatchObject({
      kind: 'shared',
      accountName: 'Checking',
      totalCents: -6000,
      otherSpacesCents: -4000,
    })
    expect(JSON.stringify(shared)).not.toContain('private note')
  })

  /**
   * Function: updateTransaction(... { private: true }) then listTransactions
   * Inputs:   the same lunch marked private, listed from BIZ
   * Expected: BIZ still sees its split, date, payee and description but account name, total and
   *           "other Spaces" are hidden (null)
   */
  it('hides account, total and other splits from the other Space once private', () => {
    const w = makeLedgerWorld()
    lunch(w, true)
    const shared = listTransactions(w.deps, IDS.BIZ, q).transactions[0]!
    expect(shared).toMatchObject({
      kind: 'shared',
      accountName: null,
      totalCents: null,
      otherSpacesCents: null,
      payee: 'Cafe',
    })
  })

  /**
   * Function: getTransaction(deps, spaceId, txnId)
   * Inputs:   a HOME-only transaction requested from BIZ; the lunch requested from BIZ
   * Expected: "not_found" for the HOME-only one (BIZ has no stake); the lunch returns the shared
   *           view and no transfer info
   */
  it('hides transactions a Space has no stake in', () => {
    const w = makeLedgerWorld()
    const plain = createTransaction(w.deps, w.actors.ann, IDS.HOME, {
      accountId: IDS.CHECKING,
      date: '2030-01-14',
      amountCents: -1,
      description: 'x',
    }).id
    expect(codeOf(() => getTransaction(w.deps, IDS.BIZ, plain))).toBe('not_found')
    const got = getTransaction(w.deps, IDS.BIZ, lunch(w, false))
    expect(got.transaction.kind).toBe('shared')
    expect(got.transfer).toBeNull()
  })
})

describe('linkTransfer / unlinkTransfer', () => {
  const pair = (w: ReturnType<typeof makeLedgerWorld>) => {
    const out = createTransaction(w.deps, w.actors.ann, IDS.HOME, {
      accountId: IDS.CHECKING,
      date: '2030-01-14',
      amountCents: -5000,
      description: 'To savings',
    }).id
    const inn = createTransaction(w.deps, w.actors.ann, IDS.HOME, {
      accountId: IDS.SAVINGS,
      date: '2030-01-14',
      amountCents: 5000,
      description: 'From checking',
    }).id
    return { out, inn }
  }

  /**
   * Function: linkTransfer(deps, actor, spaceId, aId, bId)
   * Inputs:   a -5000 on CHECKING and +5000 on SAVINGS, given in "wrong" order (in, then out)
   * Expected: linked with from = the money-out one; either transaction now reports the transfer
   */
  it('links money-out to money-in regardless of argument order', () => {
    const w = makeLedgerWorld()
    const { out, inn } = pair(w)
    const link = linkTransfer(w.deps, w.actors.ann, IDS.HOME, inn, out)
    expect(link).toMatchObject({ fromTransactionId: out, toTransactionId: inn })
    expect(getTransaction(w.deps, IDS.HOME, inn).transfer).toMatchObject({ id: link.id })
  })

  /**
   * Function: linkTransfer(...) (rules)
   * Inputs:   a pair already linked, linked again; a -5000 with a +4000; two on one account; a
   *           pair across currencies (CHECKING USD -1000 with EUR +1000)
   * Expected: "already_linked" (409); "cannot_link" with problem "not_opposite"; "same_account";
   *           "currency_mismatch"
   */
  it('refuses links that are not valid transfers', () => {
    const w = makeLedgerWorld()
    const { out, inn } = pair(w)
    linkTransfer(w.deps, w.actors.ann, IDS.HOME, out, inn)
    expect(codeOf(() => linkTransfer(w.deps, w.actors.ann, IDS.HOME, out, inn))).toBe(
      'already_linked',
    )

    const mk = (account: string, amountCents: number) =>
      createTransaction(w.deps, w.actors.ann, IDS.HOME, {
        accountId: account,
        date: '2030-01-15',
        amountCents,
        description: 'x',
      }).id
    const problem = (a: string, b: string) => {
      try {
        linkTransfer(w.deps, w.actors.ann, IDS.HOME, a, b)
      } catch (e) {
        return (e as LedgerError).extra.problem
      }
    }
    expect(problem(mk(IDS.CHECKING, -5000), mk(IDS.SAVINGS, 4000))).toBe('not_opposite')
    expect(problem(mk(IDS.CHECKING, -700), mk(IDS.CHECKING, 700))).toBe('same_account')
    expect(problem(mk(IDS.CHECKING, -1000), mk(IDS.EUR, 1000))).toBe('currency_mismatch')
  })

  /**
   * Function: linkTransfer(...) (permissions across Spaces)
   * Inputs:   ann (HOME only) linking HOME's CHECKING -3000 to BIZ's CARD +3000; then dee (both)
   * Expected: ann gets "not_found" (she can't edit the BIZ account, so it doesn't exist to her);
   *           dee can link them
   */
  it('needs edit rights on both accounts when linking across Spaces', () => {
    const w = makeLedgerWorld()
    const out = createTransaction(w.deps, w.actors.ann, IDS.HOME, {
      accountId: IDS.CHECKING,
      date: '2030-01-14',
      amountCents: -3000,
      description: 'To biz',
    }).id
    const inn = createTransaction(w.deps, w.actors.cy, IDS.BIZ, {
      accountId: IDS.CARD,
      date: '2030-01-14',
      amountCents: 3000,
      description: 'From home',
    }).id
    expect(codeOf(() => linkTransfer(w.deps, w.actors.ann, IDS.HOME, out, inn))).toBe('not_found')
    expect(linkTransfer(w.deps, w.actors.dee, IDS.HOME, out, inn)).toMatchObject({
      fromTransactionId: out,
    })
  })

  /**
   * Function: updateTransaction / removeTransaction on a linked transaction; unlinkTransfer
   * Inputs:   a linked pair; change one amount; unlink; change the amount; link again then delete
   * Expected: the amount change is refused with "linked_transfer" while linked; after unlinking
   *           it works; deleting a linked transaction also removes the link
   */
  it('keeps linked pairs consistent and cleans up the link on delete', () => {
    const w = makeLedgerWorld()
    const { out, inn } = pair(w)
    linkTransfer(w.deps, w.actors.ann, IDS.HOME, out, inn)
    expect(
      codeOf(() => updateTransaction(w.deps, w.actors.ann, IDS.HOME, out, { amountCents: -6000 })),
    ).toBe('linked_transfer')
    unlinkTransfer(w.deps, w.actors.ann, IDS.HOME, out)
    expect(
      codeOf(() => updateTransaction(w.deps, w.actors.ann, IDS.HOME, out, { amountCents: -6000 })),
    ).toBe('no error')
    updateTransaction(w.deps, w.actors.ann, IDS.HOME, out, { amountCents: -5000 })
    linkTransfer(w.deps, w.actors.ann, IDS.HOME, out, inn)
    removeTransaction(w.deps, IDS.HOME, out)
    expect(w.repos.transfers.findByTransaction(inn)).toBeUndefined()
  })
})

describe('ledger invariants across all writes', () => {
  /**
   * Function: transactions.findInvariantViolations() after a mix of service writes
   * Inputs:   creates, split edits, amount edits, a cross-Space split and a removal
   * Expected: an empty list: no active transaction ever ends up with splits that don't sum
   */
  it('never leaves an active transaction with unbalanced splits', () => {
    const w = makeLedgerWorld()
    const a = createTransaction(w.deps, w.actors.dee, IDS.HOME, {
      accountId: IDS.CHECKING,
      date: '2030-01-14',
      amountCents: -9999,
      description: 'a',
    }).id
    updateTransaction(w.deps, w.actors.dee, IDS.HOME, a, { amountCents: -12345 })
    updateTransaction(w.deps, w.actors.dee, IDS.HOME, a, {
      splits: [
        { spaceId: IDS.HOME, amountCents: -10000 },
        { spaceId: IDS.BIZ, amountCents: -2345 },
      ],
    })
    const b = createTransaction(w.deps, w.actors.ann, IDS.HOME, {
      accountId: IDS.SAVINGS,
      date: '2030-01-14',
      amountCents: 777,
      description: 'b',
    }).id
    removeTransaction(w.deps, IDS.HOME, b)
    expect(w.repos.transactions.findInvariantViolations()).toEqual([])
  })
})
