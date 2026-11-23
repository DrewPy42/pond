import { describe, expect, it } from 'vitest'
import { LedgerError, createTransaction, updateTransaction } from '../ledger/service'
import { IDS, makeLedgerWorld, type LedgerWorld } from '../testing/ledgerWorld'
import {
  applyRulesToTransaction,
  createRule,
  deleteRule,
  listRules,
  previewRule,
  runRulesOnExisting,
  updateRule,
} from './service'

/**
 * Rules service tests on makeLedgerWorld() mock data (see testing/ledgerWorld.ts: spaces HOME/BIZ;
 * ann edits HOME, bob views HOME, cy edits BIZ, dee edits both; accounts CHECKING/SAVINGS in HOME,
 * CARD in BIZ). Everything runs on in-memory fakes: no database.
 */

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return e instanceof LedgerError ? e.code : `other:${(e as Error).message}`
  }
  return 'no error'
}
const contains = (value: string) => ({
  type: 'text' as const,
  field: 'description' as const,
  op: 'contains' as const,
  value,
})
const newTxn = (
  w: LedgerWorld,
  description: string,
  amountCents = -1000,
  accountId: string = IDS.CHECKING,
  space: string = IDS.HOME,
) => {
  // A fresh bank-like transaction: one default split, not edited by a person.
  const id = `t-${w.deps.newId()}`
  const split = { id: w.deps.newId(), spaceId: space, amountCents }
  w.repos.transactions.create(
    {
      id,
      accountId,
      source: 'simplefin',
      date: '2030-01-15',
      amountCents,
      descriptionRaw: description,
      externalId: `x-${id}`,
    },
    [split],
  )
  return id
}
const rule = (
  w: LedgerWorld,
  who: 'ann' | 'dee' | 'cy',
  input: Partial<Parameters<typeof createRule>[3]> & {
    actions: Parameters<typeof createRule>[3]['actions']
  },
  space: string = IDS.HOME,
) =>
  createRule(w.deps, w.actors[who], space, {
    name: 'r',
    priority: 100,
    enabled: true,
    conditions: [contains('market')],
    ...input,
  })

describe('createRule / updateRule / deleteRule (validation)', () => {
  /**
   * Function: createRule(deps, actor, spaceId, input), listRules
   * Inputs:   ann creates a rule setting Groceries for descriptions containing "market"
   * Expected: stored in HOME with its priority, enabled, conditions and actions; listed
   */
  it('stores a valid rule', () => {
    const w = makeLedgerWorld()
    const r = rule(w, 'ann', {
      actions: [{ type: 'set_category', categoryId: w.category('HOME', 'Groceries') }],
    })
    expect(r).toMatchObject({ spaceId: IDS.HOME, enabled: true, priority: 100 })
    expect(listRules(w.deps, IDS.HOME).map((x) => x.id)).toEqual([r.id])
    expect(listRules(w.deps, IDS.BIZ)).toEqual([])
  })
  /**
   * Function: createRule(...) (references)
   * Inputs:   a category from BIZ in a HOME rule; an archived category; an account from another Space;
   *           a move to an unknown Space
   * Expected: "invalid_category", "invalid_category", "invalid_account", "unknown_space"
   */
  it('refuses rules that point at things that do not belong', () => {
    const w = makeLedgerWorld()
    const dining = w.category('HOME', 'Dining Out')
    w.repos.categories.update(dining, { archivedAt: '2030-01-01T00:00:00.000Z' })
    expect(
      code(() =>
        rule(w, 'ann', {
          actions: [{ type: 'set_category', categoryId: w.category('BIZ', 'Advertising') }],
        }),
      ),
    ).toBe('invalid_category')
    expect(
      code(() => rule(w, 'ann', { actions: [{ type: 'set_category', categoryId: dining }] })),
    ).toBe('invalid_category')
    expect(
      code(() =>
        rule(w, 'ann', {
          conditions: [{ type: 'account', accountId: IDS.CARD }],
          actions: [{ type: 'set_payee', payee: 'x' }],
        }),
      ),
    ).toBe('invalid_account')
    expect(
      code(() => rule(w, 'ann', { actions: [{ type: 'move_to_space', spaceId: 'nope' }] })),
    ).toBe('unknown_space')
  })
  /**
   * Function: createRule(...) (moving money to another Space)
   * Inputs:   ann (edits HOME only) makes a rule moving to BIZ; dee (edits both) does the same, with a
   *           BIZ category (valid for the target Space)
   * Expected: ann gets "forbidden_space"; dee succeeds
   */
  it('lets only someone who can edit the target Space create a move rule', () => {
    const w = makeLedgerWorld()
    expect(
      code(() => rule(w, 'ann', { actions: [{ type: 'move_to_space', spaceId: IDS.BIZ }] })),
    ).toBe('forbidden_space')
    const r = rule(w, 'dee', {
      actions: [
        { type: 'move_to_space', spaceId: IDS.BIZ },
        { type: 'set_category', categoryId: w.category('BIZ', 'Supplies') },
      ],
    })
    expect(r.actions).toHaveLength(2)
  })
  /**
   * Function: updateRule / deleteRule
   * Inputs:   rename and disable a rule; edit one that belongs to another Space; delete it
   * Expected: changes stored; cross-Space edit or delete gives "not_found"; deleted rules vanish
   */
  it('edits and deletes only rules in the same Space', () => {
    const w = makeLedgerWorld()
    const r = rule(w, 'ann', { actions: [{ type: 'set_payee', payee: 'Market' }] })
    expect(
      updateRule(w.deps, w.actors.ann, IDS.HOME, r.id, { name: 'Renamed', enabled: false }),
    ).toMatchObject({ name: 'Renamed', enabled: false })
    expect(code(() => updateRule(w.deps, w.actors.cy, IDS.BIZ, r.id, { name: 'x' }))).toBe(
      'not_found',
    )
    expect(code(() => deleteRule(w.deps, IDS.BIZ, r.id))).toBe('not_found')
    deleteRule(w.deps, IDS.HOME, r.id)
    expect(listRules(w.deps, IDS.HOME)).toEqual([])
  })
})

describe('applyRulesToTransaction(deps, transactionId)', () => {
  /**
   * Inputs:   a rule (contains "market" -> category Groceries, payee "Corner Market", reimbursable); a
   *           new -1000 transaction "CORNER MARKET"
   * Expected: the transaction gets that payee; its single split gets the category and reimbursable
   *           flag; splits still balance; it is NOT marked as edited by a person
   */
  it('categorizes, sets the payee and marks reimbursable on a new transaction', () => {
    const w = makeLedgerWorld()
    const groceries = w.category('HOME', 'Groceries')
    rule(w, 'ann', {
      actions: [
        { type: 'set_category', categoryId: groceries },
        { type: 'set_payee', payee: 'Corner Market' },
        { type: 'mark_reimbursable' },
      ],
    })
    const id = newTxn(w, 'CORNER MARKET #12')
    expect(applyRulesToTransaction(w.deps, id)).toMatchObject({ changed: true })
    const t = w.repos.transactions.findById(id)!
    expect(t.txn).toMatchObject({ payee: 'Corner Market', userEdited: false })
    expect(t.splits.map((s) => [s.categoryId, s.reimbursable, s.amountCents])).toEqual([
      [groceries, true, -1000],
    ])
    expect(w.repos.transactions.findInvariantViolations()).toEqual([])
  })
  /**
   * Inputs:   the same rule; a transaction that does not match ("HARDWARE STORE"); a transaction a
   *           person has edited; a removed transaction
   * Expected: none of them change (rules never touch edited or removed transactions)
   */
  it('leaves non-matching, user-edited and removed transactions alone', () => {
    const w = makeLedgerWorld()
    rule(w, 'ann', {
      actions: [{ type: 'set_category', categoryId: w.category('HOME', 'Groceries') }],
    })
    const none = newTxn(w, 'HARDWARE STORE')
    const edited = newTxn(w, 'CORNER MARKET')
    updateTransaction(w.deps, w.actors.ann, IDS.HOME, edited, { memo: 'mine' })
    const removed = newTxn(w, 'CORNER MARKET 2')
    w.repos.transactions.update(removed, { status: 'removed' })
    for (const id of [none, edited, removed])
      expect(applyRulesToTransaction(w.deps, id).changed, id).toBe(false)
    expect(w.repos.transactions.findById(edited)!.splits[0]!.categoryId).toBeNull()
  })
  /**
   * Inputs:   rule A (priority 10, Groceries) and rule B (priority 20, Dining Out) both matching
   * Expected: the lower priority number wins: Groceries
   */
  it('lets the higher-priority rule win', () => {
    const w = makeLedgerWorld()
    const groceries = w.category('HOME', 'Groceries')
    rule(w, 'ann', {
      name: 'B',
      priority: 20,
      actions: [{ type: 'set_category', categoryId: w.category('HOME', 'Dining Out') }],
    })
    rule(w, 'ann', {
      name: 'A',
      priority: 10,
      actions: [{ type: 'set_category', categoryId: groceries }],
    })
    const id = newTxn(w, 'CORNER MARKET')
    applyRulesToTransaction(w.deps, id)
    expect(w.repos.transactions.findById(id)!.splits[0]!.categoryId).toBe(groceries)
  })
  /**
   * Inputs:   a disabled rule and an account-scoped rule for SAVINGS, applied to a CHECKING transaction
   * Expected: nothing changes
   */
  it('ignores disabled rules and rules for other accounts', () => {
    const w = makeLedgerWorld()
    rule(w, 'ann', { enabled: false, actions: [{ type: 'set_payee', payee: 'X' }] })
    rule(w, 'ann', {
      conditions: [contains('market'), { type: 'account', accountId: IDS.SAVINGS }],
      actions: [{ type: 'set_payee', payee: 'Y' }],
    })
    expect(applyRulesToTransaction(w.deps, newTxn(w, 'CORNER MARKET')).changed).toBe(false)
  })

  /**
   * Inputs:   dee's rule moving "market" purchases to BIZ with BIZ's Supplies category; a new HOME
   *           transaction "CORNER MARKET"
   * Expected: its split moves to BIZ with the BIZ category (the BIZ Space now sees it as a shared transaction)
   */
  it('moves a split to another Space when the rule creator may edit it', () => {
    const w = makeLedgerWorld()
    const supplies = w.category('BIZ', 'Supplies')
    rule(w, 'dee', {
      actions: [
        { type: 'move_to_space', spaceId: IDS.BIZ },
        { type: 'set_category', categoryId: supplies },
      ],
    })
    const id = newTxn(w, 'CORNER MARKET')
    expect(applyRulesToTransaction(w.deps, id).changed).toBe(true)
    expect(w.repos.transactions.findById(id)!.splits.map((s) => [s.spaceId, s.categoryId])).toEqual(
      [[IDS.BIZ, supplies]],
    )
  })
  /**
   * Inputs:   the same move rule, but its creator (dee) later loses access to BIZ
   * Expected: the move is NOT made (a rule can't outlive its creator's permission); the transaction stays
   *           in HOME
   */
  it('stops moving money once the rule creator can no longer edit the target Space', () => {
    const w = makeLedgerWorld()
    rule(w, 'dee', { actions: [{ type: 'move_to_space', spaceId: IDS.BIZ }] })
    w.repos.spaces.removeMember(IDS.BIZ, IDS.dee)
    const id = newTxn(w, 'CORNER MARKET')
    applyRulesToTransaction(w.deps, id)
    expect(w.repos.transactions.findById(id)!.splits[0]!.spaceId).toBe(IDS.HOME)
  })
  /**
   * Inputs:   a rule with a HOME category and a move to BIZ, where the category was valid when saved but
   *           the rule is edited... here: a HOME-category rule plus a separate higher-priority move rule
   * Expected: the category is skipped because it does not belong to the Space the money moved to
   */
  it('skips a category that does not belong to the Space the split ended up in', () => {
    const w = makeLedgerWorld()
    rule(w, 'dee', {
      name: 'move',
      priority: 1,
      actions: [{ type: 'move_to_space', spaceId: IDS.BIZ }],
    })
    rule(w, 'ann', {
      name: 'cat',
      priority: 2,
      actions: [{ type: 'set_category', categoryId: w.category('HOME', 'Groceries') }],
    })
    const id = newTxn(w, 'CORNER MARKET')
    applyRulesToTransaction(w.deps, id)
    expect(w.repos.transactions.findById(id)!.splits.map((s) => [s.spaceId, s.categoryId])).toEqual(
      [[IDS.BIZ, null]],
    )
  })
  /**
   * Inputs:   a transaction that already has two splits (e.g. carried over from a pending one)
   * Expected: its splits are untouched; only the payee can change
   */
  it("never rewrites a multi-split transaction's splits", () => {
    const w = makeLedgerWorld()
    rule(w, 'ann', {
      actions: [
        { type: 'set_category', categoryId: w.category('HOME', 'Groceries') },
        { type: 'set_payee', payee: 'Market' },
      ],
    })
    const id = `t-${w.deps.newId()}`
    w.repos.transactions.create(
      {
        id,
        accountId: IDS.CHECKING,
        source: 'simplefin',
        date: '2030-01-15',
        amountCents: -1000,
        descriptionRaw: 'CORNER MARKET',
        externalId: 'm',
      },
      [
        { id: 's1', spaceId: IDS.HOME, amountCents: -600 },
        { id: 's2', spaceId: IDS.HOME, amountCents: -400 },
      ],
    )
    applyRulesToTransaction(w.deps, id)
    const t = w.repos.transactions.findById(id)!
    expect(t.splits.map((s) => [s.amountCents, s.categoryId])).toEqual([
      [-600, null],
      [-400, null],
    ])
    expect(t.txn.payee).toBe('Market')
  })
})

describe('applyRulesToTransaction: link as transfer', () => {
  const setup = () => {
    const w = makeLedgerWorld()
    rule(w, 'ann', { conditions: [contains('to savings')], actions: [{ type: 'link_transfer' }] })
    const out = newTxn(w, 'TRANSFER TO SAVINGS', -50000, IDS.CHECKING)
    return { w, out }
  }
  /**
   * Inputs:   a rule "contains 'to savings' -> link as transfer"; a -50000 on CHECKING and exactly one
   *           matching +50000 on SAVINGS two days earlier
   * Expected: they are linked with createdBy "rule", money-out as the from side
   */
  it('links to the one matching opposite transaction', () => {
    const { w, out } = setup()
    const inn = newTxn(w, 'DEPOSIT', 50000, IDS.SAVINGS)
    expect(applyRulesToTransaction(w.deps, out).linkedTransfer).toBe(true)
    expect(w.repos.transfers.findByTransaction(out)).toMatchObject({
      fromTransactionId: out,
      toTransactionId: inn,
      createdBy: 'rule',
    })
  })
  /**
   * Inputs:   two possible +50000 matches; and none
   * Expected: no link either way (ambiguous or missing: left for a person)
   */
  it('does nothing when the match is ambiguous or missing', () => {
    const { w, out } = setup()
    expect(applyRulesToTransaction(w.deps, out).linkedTransfer).toBe(false)
    newTxn(w, 'DEPOSIT A', 50000, IDS.SAVINGS)
    newTxn(w, 'DEPOSIT B', 50000, IDS.SAVINGS)
    expect(applyRulesToTransaction(w.deps, out).linkedTransfer).toBe(false)
    expect(w.repos.transfers.findByTransaction(out)).toBeUndefined()
  })
  /**
   * Inputs:   the only match is on BIZ's CARD, which the rule creator (ann) can't edit
   * Expected: no link (same permission rule as linking by hand)
   */
  it('will not link to an account the rule creator cannot edit', () => {
    const { w, out } = setup()
    newTxn(w, 'FROM HOME', 50000, IDS.CARD, IDS.BIZ)
    expect(applyRulesToTransaction(w.deps, out).linkedTransfer).toBe(false)
  })
})

describe('runRulesOnExisting(deps, spaceId) and previewRule(deps, spaceId, conditions)', () => {
  /**
   * Function: runRulesOnExisting
   * Inputs:   three existing HOME transactions: uncategorized matching, already categorized matching, and
   *           one a person edited; one rule setting Groceries for "market"
   * Expected: only the first changes; examined counts the eligible (untouched, uncategorized) ones
   */
  it('categorizes only untouched, uncategorized transactions', () => {
    const w = makeLedgerWorld()
    const groceries = w.category('HOME', 'Groceries')
    rule(w, 'ann', { actions: [{ type: 'set_category', categoryId: groceries }] })
    const a = newTxn(w, 'CORNER MARKET')
    const b = newTxn(w, 'CORNER MARKET TWO')
    w.repos.transactions.update(b, {}, [
      {
        id: 'sb',
        spaceId: IDS.HOME,
        amountCents: -1000,
        categoryId: w.category('HOME', 'Dining Out'),
      },
    ])
    const c = newTxn(w, 'CORNER MARKET THREE')
    updateTransaction(w.deps, w.actors.ann, IDS.HOME, c, { memo: 'mine' })
    const summary = runRulesOnExisting(w.deps, IDS.HOME)
    expect(summary).toEqual({ examined: 1, changed: 1 })
    expect(w.repos.transactions.findById(a)!.splits[0]!.categoryId).toBe(groceries)
    expect(w.repos.transactions.findById(b)!.splits[0]!.categoryId).not.toBe(groceries)
    expect(w.repos.transactions.findById(c)!.splits[0]!.categoryId).toBeNull()
  })
  /**
   * Function: previewRule
   * Inputs:   conditions "contains market" over three HOME transactions (two match) plus one
   *           transaction on BIZ's account that is shared into HOME by a split
   * Expected: examined 3 and matched 2: only transactions on HOME's own accounts count (rules apply
   *           to a Space's own accounts); the samples hold the two matches
   */
  it("counts how many of the Space's own transactions would match", () => {
    const w = makeLedgerWorld()
    newTxn(w, 'CORNER MARKET')
    newTxn(w, 'FARMERS MARKET')
    newTxn(w, 'GAS STATION')
    createTransaction(w.deps, w.actors.dee, IDS.BIZ, {
      accountId: IDS.CARD,
      date: '2030-01-14',
      amountCents: -500,
      description: 'MARKET LUNCH',
      splits: [
        { spaceId: IDS.BIZ, amountCents: -300 },
        { spaceId: IDS.HOME, amountCents: -200 },
      ],
    })
    const p = previewRule(w.deps, IDS.HOME, [contains('market')])
    expect(p).toMatchObject({ examined: 3, matched: 2 })
    expect(p.samples).toHaveLength(2)
  })
})
