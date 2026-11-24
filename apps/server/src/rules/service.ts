import type {
  CreateRuleInput,
  RuleAction,
  RuleCondition,
  RuleRunSummary,
  RuleView,
  TransactionView,
  UpdateRuleInput,
} from '@pond/shared'
import {
  LedgerError,
  announceTransaction,
  canEditSpace,
  type Actor,
  type Deps,
} from '../ledger/service.js'
import { checkTransferPair, orientTransfer } from '../ledger/transfers.js'
import { viewTransaction } from '../ledger/visibility.js'
import type { NewSplit, RuleRecord, TransactionWithSplits } from '../repos/types.js'
import { evaluateRules, ruleMatches, type RuleInput } from './engine.js'

/**
 * Applying rules (docs/architecture.md, "Rules engine"). The engine decides; this checks the
 * pieces that need data (does the category belong to the target Space? may the rule's creator
 * move money there?) and writes through repositories. Rules run on NEW transactions and never on
 * ones a person has edited.
 */

const DAY = 86_400_000
const shift = (d: string, days: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
const TRANSFER_WINDOW_DAYS = 5

export const ruleView = (r: RuleRecord): RuleView => ({
  id: r.id,
  spaceId: r.spaceId,
  name: r.name,
  priority: r.priority,
  enabled: r.enabled,
  conditions: r.conditions,
  actions: r.actions,
})

const notFound = () => new LedgerError(404, 'not_found')

export const listRules = (d: Deps, spaceId: string): RuleView[] =>
  d.repos.rules.listForSpace(spaceId).map(ruleView)

/** Checks everything a rule refers to, so a saved rule can only ever point at real, allowed things. */
function validateReferences(
  d: Deps,
  actor: Actor,
  spaceId: string,
  conditions: RuleCondition[],
  actions: RuleAction[],
) {
  for (const c of conditions) {
    if (c.type === 'account') {
      const a = d.repos.accounts.findById(c.accountId)
      if (!a || a.primarySpaceId !== spaceId) throw new LedgerError(400, 'invalid_account')
    }
  }
  const move = actions.find(
    (a): a is Extract<RuleAction, { type: 'move_to_space' }> => a.type === 'move_to_space',
  )
  const targetSpace = move?.spaceId ?? spaceId
  if (move) {
    if (!d.repos.spaces.findById(move.spaceId)) throw new LedgerError(400, 'unknown_space')
    if (!canEditSpace(d.repos, actor, move.spaceId)) throw new LedgerError(403, 'forbidden_space')
  }
  for (const a of actions) {
    if (a.type !== 'set_category') continue
    const cat = d.repos.categories.findById(a.categoryId)
    if (!cat || cat.archivedAt !== null || cat.spaceId !== targetSpace)
      throw new LedgerError(400, 'invalid_category')
  }
}

export function createRule(
  d: Deps,
  actor: Actor,
  spaceId: string,
  input: CreateRuleInput,
): RuleView {
  validateReferences(d, actor, spaceId, input.conditions, input.actions)
  const id = d.newId()
  d.repos.rules.create({
    id,
    spaceId,
    name: input.name,
    priority: input.priority,
    enabled: input.enabled,
    conditions: input.conditions,
    actions: input.actions,
    createdBy: actor.id,
  })
  return ruleView(d.repos.rules.findById(id)!)
}

export function updateRule(
  d: Deps,
  actor: Actor,
  spaceId: string,
  ruleId: string,
  input: UpdateRuleInput,
): RuleView {
  const rule = d.repos.rules.findById(ruleId)
  if (!rule || rule.spaceId !== spaceId) throw notFound()
  const conditions = input.conditions ?? rule.conditions
  const actions = input.actions ?? rule.actions
  validateReferences(d, actor, spaceId, conditions, actions)
  // Whoever last changed what a rule does is the one whose permissions it runs under.
  const changesBehavior = input.conditions !== undefined || input.actions !== undefined
  d.repos.rules.update(ruleId, { ...input, ...(changesBehavior ? { createdBy: actor.id } : {}) })
  return ruleView(d.repos.rules.findById(ruleId)!)
}

export function deleteRule(d: Deps, spaceId: string, ruleId: string): void {
  const rule = d.repos.rules.findById(ruleId)
  if (!rule || rule.spaceId !== spaceId) throw notFound()
  d.repos.rules.delete(ruleId)
}

const ruleInput = (t: TransactionWithSplits): RuleInput => ({
  descriptionRaw: t.txn.descriptionRaw,
  payee: t.txn.payee,
  amountCents: t.txn.amountCents,
  accountId: t.txn.accountId,
})

/** Can the person who last saved this rule still do what it asks in `spaceId`? */
function creatorCanEdit(d: Deps, ruleId: string | undefined, spaceId: string): boolean {
  const rule = ruleId ? findRule(d, ruleId) : undefined
  const user = rule ? d.repos.users.findById(rule.createdBy) : undefined
  if (!user || user.status !== 'active') return false
  return canEditSpace(d.repos, { id: user.id, isAdmin: user.isAdmin }, spaceId)
}
const findRule = (d: Deps, ruleId: string): RuleRecord | undefined => d.repos.rules.findById(ruleId)

export interface RuleApplication {
  changed: boolean
  linkedTransfer: boolean
}

/**
 * Runs the account's Space's rules on one transaction. Skips transactions a person edited,
 * removed ones, and accounts with no Space. Safe to call on any transaction.
 */
export function applyRulesToTransaction(d: Deps, txnId: string): RuleApplication {
  const none = { changed: false, linkedTransfer: false }
  const found = d.repos.transactions.findById(txnId)
  if (!found || found.txn.userEdited || found.txn.status !== 'active') return none
  const homeSpace = found.account.primarySpaceId
  if (!homeSpace) return none
  const rules = d.repos.rules.listForSpace(homeSpace)
  if (rules.length === 0) return none

  const outcome = evaluateRules(rules, ruleInput(found))
  if (outcome.matched.length === 0) return none

  // Where the money should land: the rule's chosen Space, if its creator may put money there.
  let targetSpace = homeSpace
  if (outcome.spaceId && outcome.spaceId !== homeSpace) {
    if (
      d.repos.spaces.findById(outcome.spaceId) &&
      creatorCanEdit(d, outcome.from.spaceId, outcome.spaceId)
    ) {
      targetSpace = outcome.spaceId
    }
  }
  let categoryId: string | null | undefined
  if (outcome.categoryId) {
    const cat = d.repos.categories.findById(outcome.categoryId)
    if (cat && cat.archivedAt === null && cat.spaceId === targetSpace) categoryId = cat.id
  }

  let changed = false
  const patch: { payee?: string } = {}
  if (outcome.payee !== undefined && outcome.payee !== found.txn.payee) {
    patch.payee = outcome.payee
    changed = true
  }

  // Splits are only rewritten for a plain one-split transaction (a new one, as rules intend).
  let splits: NewSplit[] | undefined
  if (found.splits.length === 1) {
    const only = found.splits[0]!
    const next = {
      spaceId: targetSpace,
      categoryId: categoryId ?? only.categoryId,
      reimbursable: outcome.reimbursable ?? only.reimbursable,
    }
    if (
      next.spaceId !== only.spaceId ||
      next.categoryId !== only.categoryId ||
      next.reimbursable !== only.reimbursable
    ) {
      splits = [{ id: d.newId(), amountCents: only.amountCents, memo: only.memo, ...next }]
      changed = true
    }
  }
  if (Object.keys(patch).length > 0 || splits) d.repos.transactions.update(txnId, patch, splits)

  let linkedTransfer = false
  if (outcome.linkTransfer) linkedTransfer = tryAutoLink(d, found, outcome.from.linkTransfer)
  return { changed: changed || linkedTransfer, linkedTransfer }
}

/** Links to the single matching opposite transaction on another account, if there is exactly one. */
function tryAutoLink(d: Deps, found: TransactionWithSplits, ruleId: string | undefined): boolean {
  if (d.repos.transfers.findByTransaction(found.txn.id)) return false
  const candidates = d.repos.transactions
    .findOppositeCandidates({
      amountCents: -found.txn.amountCents,
      excludeAccountId: found.txn.accountId,
      currency: found.account.currency,
      from: shift(found.txn.date, -TRANSFER_WINDOW_DAYS),
      to: shift(found.txn.date, TRANSFER_WINDOW_DAYS),
    })
    // Only accounts the rule's creator can edit (same rule as linking by hand).
    .filter(
      (c) =>
        c.account.primarySpaceId !== null && creatorCanEdit(d, ruleId, c.account.primarySpaceId),
    )
  if (candidates.length !== 1) return false // none, or ambiguous: leave it for a person
  const other = candidates[0]!
  const a = { txn: found.txn, account: found.account }
  const b = { txn: other.txn, account: other.account }
  if (checkTransferPair(a, b)) return false
  const { from, to } = orientTransfer(a, b)
  d.repos.transfers.create({
    id: d.newId(),
    fromTransactionId: from.txn.id,
    toTransactionId: to.txn.id,
    createdBy: 'rule',
  })
  return true
}

/** Transactions on this Space's own accounts that rules may still change: untouched and uncategorized. */
function* eligibleTransactions(
  d: Deps,
  spaceId: string,
  limit: number,
): Generator<TransactionWithSplits> {
  const PAGE = 500
  let seen = 0
  for (let offset = 0; seen < limit; offset += PAGE) {
    const { rows } = d.repos.transactions.listForSpace(spaceId, {}, { limit: PAGE, offset })
    if (rows.length === 0) return
    for (const r of rows) {
      if (seen++ >= limit) return
      if (r.account.primarySpaceId !== spaceId || r.txn.userEdited) continue
      if (r.splits.some((s) => s.categoryId !== null)) continue
      yield r
    }
    if (rows.length < PAGE) return
  }
}

const RUN_LIMIT = 20_000

/** "Run on uncategorized": apply the Space's rules to existing transactions nobody has touched. */
export function runRulesOnExisting(d: Deps, spaceId: string): RuleRunSummary {
  const summary: RuleRunSummary = { examined: 0, changed: 0 }
  const ids: string[] = []
  for (const t of eligibleTransactions(d, spaceId, RUN_LIMIT)) ids.push(t.txn.id)
  for (const id of ids) {
    summary.examined++
    if (applyRulesToTransaction(d, id).changed) {
      summary.changed++
      announceTransaction(d, 'split.changed', id)
    }
  }
  return summary
}

const PREVIEW_LOOKBACK = 2000

/** "Test this rule": how many recent transactions would these conditions match, and a few examples. */
export function previewRule(d: Deps, spaceId: string, conditions: RuleCondition[]) {
  let examined = 0
  let matched = 0
  const samples: TransactionView[] = []
  const PAGE = 500
  for (let offset = 0; examined < PREVIEW_LOOKBACK; offset += PAGE) {
    const { rows } = d.repos.transactions.listForSpace(spaceId, {}, { limit: PAGE, offset })
    if (rows.length === 0) break
    for (const r of rows) {
      if (r.account.primarySpaceId !== spaceId) continue
      examined++
      if (!ruleMatches({ conditions }, ruleInput(r))) continue
      matched++
      const v = viewTransaction(r.txn, r.splits, r.account, spaceId)
      if (v && samples.length < 10) samples.push(v)
    }
    if (rows.length < PAGE) break
  }
  return { examined, matched, samples }
}
