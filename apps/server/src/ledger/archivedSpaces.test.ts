import { describe, expect, it } from 'vitest'
import { applyRulesToTransaction, createRule } from '../rules/service.js'
import { IDS, makeLedgerWorld } from '../testing/ledgerWorld.js'
import {
  canEditSpace,
  createTransaction,
  linkTransfer,
  removeTransaction,
  updateTransaction,
} from './service.js'

/**
 * What an archived Space means for the ledger: nothing new goes in, and what it already recorded
 * stays exactly as it was, even when it is part of another Space's transaction.
 *
 * Mock data (ledger world, fakes): "dee" edits HOME and BIZ. A $100.00 purchase on HOME's
 * checking account is split $60 HOME (Groceries) and $40 BIZ (Supplies); then BIZ is archived.
 */
function setup() {
  const w = makeLedgerWorld()
  const split = (space: 'HOME' | 'BIZ', category: string, amountCents: number, memo?: string) => ({
    spaceId: IDS[space],
    categoryId: w.category(space, category),
    amountCents,
    ...(memo ? { memo } : {}),
  })
  const biz = () => split('BIZ', 'Supplies', -4000, 'toner')
  const txn = createTransaction(w.deps, w.actors.dee, IDS.HOME, {
    accountId: IDS.CHECKING,
    date: '2030-01-10',
    amountCents: -10000,
    description: 'Shop',
    splits: [split('HOME', 'Groceries', -6000), biz()],
  })
  const archive = () => w.repos.spaces.update(IDS.BIZ, { archivedAt: '2030-01-14T00:00:00.000Z' })
  const stored = () => w.repos.transactions.findById(txn.id)!
  const update = (input: Parameters<typeof updateTransaction>[4]) =>
    updateTransaction(w.deps, w.actors.dee, IDS.HOME, txn.id, input)
  return { w, split, biz, txn, archive, stored, update }
}

describe('an archived Space and the ledger', () => {
  /**
   * Function: canEditSpace
   * Inputs:   an editor and the administrator, before and after BIZ is archived
   * Expected: both may edit before; neither may after
   */
  it('lets nobody, administrator included, put anything new in', () => {
    const { w, archive } = setup()
    expect(canEditSpace(w.repos, w.actors.dee, IDS.BIZ)).toBe(true)
    archive()
    expect(canEditSpace(w.repos, w.actors.dee, IDS.BIZ)).toBe(false)
    expect(canEditSpace(w.repos, w.actors.admin, IDS.BIZ)).toBe(false)
  })

  /**
   * Function: createTransaction
   * Inputs:   a new HOME purchase with a part in the archived BIZ
   * Expected: refused with space_archived
   */
  it('refuses a new split into it', () => {
    const { w, biz, archive } = setup()
    archive()
    expect(() =>
      createTransaction(w.deps, w.actors.dee, IDS.HOME, {
        accountId: IDS.CHECKING,
        date: '2030-01-12',
        amountCents: -4000,
        description: 'x',
        splits: [biz()],
      }),
    ).toThrow('space_archived')
  })

  /**
   * Function: updateTransaction
   * Inputs:   after archiving: a new payee; the same splits sent back with the HOME category
   *           changed (the BIZ part unchanged, without its memo)
   * Expected: both work, and the BIZ part keeps its category, amount and memo
   */
  it('still lets the rest of the transaction be edited', () => {
    const { split, biz, archive, stored, update } = setup()
    const before = stored().splits.find((s) => s.spaceId === IDS.BIZ)!
    archive()
    update({ payee: 'Corner shop' })
    update({ splits: [split('HOME', 'Dining Out', -6000), { ...biz(), memo: 'changed' }] })
    expect(stored().txn.payee).toBe('Corner shop')
    expect(stored().splits.find((s) => s.spaceId === IDS.BIZ)).toMatchObject({
      categoryId: before.categoryId,
      amountCents: -4000,
      memo: 'toner',
    })
  })

  /**
   * Function: updateTransaction, removeTransaction (changes to what BIZ recorded)
   * Inputs:   after archiving: drop the BIZ part; change its amount; change its category; send it
   *           twice; change the date; change the amount; delete the transaction
   * Expected: every one is refused with space_archived and nothing changes
   */
  it('refuses anything that would change what it recorded', () => {
    const { w, split, biz, txn, archive, stored, update } = setup()
    const before = JSON.stringify(stored())
    archive()
    const home = (cents: number) => split('HOME', 'Groceries', cents)
    for (const attempt of [
      () => update({ splits: [home(-10000)] }),
      () => update({ splits: [home(-7000), { ...biz(), amountCents: -3000 }] }),
      () => update({ splits: [home(-6000), split('BIZ', 'Travel', -4000)] }),
      () => update({ splits: [home(-2000), biz(), biz()] }),
      () => update({ date: '2030-01-11' }),
      () => update({ amountCents: -12000, splits: [home(-8000), biz()] }),
      () => removeTransaction(w.deps, IDS.HOME, txn.id),
    ])
      expect(attempt).toThrow('space_archived')
    expect(JSON.stringify(stored())).toBe(before)
  })

  /**
   * Function: linkTransfer, applyRulesToTransaction
   * Inputs:   linking the split purchase to a matching deposit; running a HOME rule that would set
   *           a payee on it
   * Expected: linking is refused (it would drop the money from BIZ's totals); the rule leaves the
   *           transaction alone
   */
  it('keeps transfers and rules away from it too', () => {
    const { w, txn, archive } = setup()
    const deposit = createTransaction(w.deps, w.actors.dee, IDS.HOME, {
      accountId: IDS.SAVINGS,
      date: '2030-01-10',
      amountCents: 10000,
      description: 'In',
    })
    createRule(w.deps, w.actors.dee, IDS.HOME, {
      name: 'Tidy',
      priority: 1,
      enabled: true,
      conditions: [{ type: 'text', field: 'description', op: 'contains', value: 'Shop' }],
      actions: [{ type: 'set_payee', payee: 'Changed' }],
    })
    // Bank-fed rows are what rules act on, so pretend nobody has edited this one.
    w.repos.transactions.update(txn.id, { userEdited: false })
    archive()
    expect(() => linkTransfer(w.deps, w.actors.dee, IDS.HOME, txn.id, deposit.id)).toThrow(
      'space_archived',
    )
    expect(applyRulesToTransaction(w.deps, txn.id).changed).toBe(false)
    expect(w.repos.transactions.findById(txn.id)!.txn.payee).toBeNull()
  })
})
