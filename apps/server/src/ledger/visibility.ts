import {
  sumCents,
  type FullTransactionView,
  type SharedTransactionView,
  type TransactionView,
} from '@pond/shared'
import type { AccountRecord, SplitRecord, TransactionRecord } from '../repos/types.js'

/**
 * Cross-Space visibility (data-model.md). A transaction lives on an account whose primary
 * Space is A, but its splits can land in other Spaces. Someone viewing it from Space B (with no
 * access to A) sees only what the table in data-model.md allows.
 */
export type { FullTransactionView, SharedTransactionView, TransactionView }

/**
 * What `viewingSpaceId` may see of one transaction.
 *  - Account belongs to the viewing Space: everything.
 *  - Otherwise: own-Space splits, date, payee and description always; account name, total and
 *    the "other Spaces" amount only if the transaction is not private. Never the account id,
 *    memo, review flag or source.
 *  - Returns null when the viewing Space has no stake (no split there): it must not appear.
 */
export function viewTransaction(
  txn: TransactionRecord,
  splits: readonly SplitRecord[],
  account: Pick<AccountRecord, 'id' | 'name' | 'primarySpaceId'>,
  viewingSpaceId: string,
): TransactionView | null {
  if (account.primarySpaceId === viewingSpaceId) {
    return {
      kind: 'full',
      id: txn.id,
      accountId: account.id,
      accountName: account.name,
      date: txn.date,
      amountCents: txn.amountCents,
      descriptionRaw: txn.descriptionRaw,
      payee: txn.payee,
      memo: txn.memo,
      pending: txn.pending,
      private: txn.private,
      needsReview: txn.needsReview,
      source: txn.source,
      splits: [...splits],
    }
  }
  const own = splits.filter((s) => s.spaceId === viewingSpaceId)
  if (own.length === 0) return null
  const others = splits.filter((s) => s.spaceId !== viewingSpaceId)
  return {
    kind: 'shared',
    id: txn.id,
    date: txn.date,
    descriptionRaw: txn.descriptionRaw,
    payee: txn.payee,
    pending: txn.pending,
    accountName: txn.private ? null : account.name,
    totalCents: txn.private ? null : txn.amountCents,
    splits: own,
    otherSpacesCents: txn.private ? null : sumCents(others.map((s) => s.amountCents)),
  }
}
