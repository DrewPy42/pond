import { assertCents, splitsBalance } from '@pond/shared'

export interface SplitInput {
  spaceId: string
  categoryId?: string | null
  amountCents: number
  memo?: string | null
  reimbursable?: boolean
}

export type SplitProblem = 'no_splits' | 'not_integer' | 'sum_mismatch'

/**
 * The split invariant (data-model.md, CLAUDE.md rule 3): a transaction has at least one split
 * and its splits sum EXACTLY to the transaction amount, all in whole cents. Returns the first
 * problem found, or null when the splits are valid.
 */
export function checkSplits(
  txnAmountCents: number,
  splits: readonly { amountCents: number }[],
): SplitProblem | null {
  if (splits.length === 0) return 'no_splits'
  try {
    assertCents(txnAmountCents)
    for (const s of splits) assertCents(s.amountCents)
  } catch {
    return 'not_integer'
  }
  return splitsBalance(
    txnAmountCents,
    splits.map((s) => s.amountCents),
  )
    ? null
    : 'sum_mismatch'
}

/** The default for a new transaction: one split covering the whole amount, uncategorized. */
export function defaultSplit(spaceId: string, amountCents: number): SplitInput {
  return { spaceId, categoryId: null, amountCents }
}
