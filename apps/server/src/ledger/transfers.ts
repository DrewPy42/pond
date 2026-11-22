import type { AccountRecord, TransactionRecord } from '../repos/types.js'

export type TransferProblem =
  'same_transaction' | 'same_account' | 'not_active' | 'not_opposite' | 'currency_mismatch'

interface Side {
  txn: TransactionRecord
  account: Pick<AccountRecord, 'id' | 'currency'>
}

/**
 * Can these two transactions be linked as one transfer? A transfer is money leaving one
 * account (negative) and arriving in another (positive) for the same amount and currency
 * (v1 does no currency conversion). Returns the reason it can't, or null.
 */
export function checkTransferPair(a: Side, b: Side): TransferProblem | null {
  if (a.txn.id === b.txn.id) return 'same_transaction'
  if (a.account.id === b.account.id) return 'same_account'
  if (a.txn.status !== 'active' || b.txn.status !== 'active') return 'not_active'
  if (a.account.currency !== b.account.currency) return 'currency_mismatch'
  if (a.txn.amountCents === 0 || a.txn.amountCents !== -b.txn.amountCents) return 'not_opposite'
  return null
}

/** Orders a pair as { from: the negative side (money out), to: the positive side }. */
export function orientTransfer<T extends { txn: TransactionRecord }>(
  a: T,
  b: T,
): { from: T; to: T } {
  return a.txn.amountCents < 0 ? { from: a, to: b } : { from: b, to: a }
}
