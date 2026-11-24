import { PadError, PadPermissionError, type ScopedCore, type SplitSumOptions } from '@pond/sdk'
import { isoDateSchema } from '@pond/shared'
import {
  LedgerError,
  listAccounts,
  listBalances,
  listCategories,
  listTransactions,
  getTransaction,
  type Deps,
} from '../ledger/service.js'

/**
 * The core facade a pad is given (docs/lilypad-contract.md, amendment A2). It is bound to ONE
 * Space, its methods take no Space argument, every call needs the matching granted permission,
 * and it returns the same privacy-filtered views the web app uses, built by the same services.
 * It is read-only in v1 (amendment A5).
 */
export function createCoreFacade(
  deps: Deps,
  grants: ReadonlySet<string>,
  spaceId: string,
): ScopedCore {
  const need = (permission: string) => {
    if (!grants.has(permission)) throw new PadPermissionError(permission)
  }
  /** A pad asked about something that isn't there (or isn't in this Space). */
  const missing = (e: unknown): never => {
    if (e instanceof LedgerError && e.status === 404) throw new PadError(404, 'not_found')
    throw e
  }

  return {
    accounts: {
      async list() {
        need('accounts:read')
        return listAccounts(deps, spaceId)
      },
    },
    categories: {
      async list(opts) {
        need('transactions:read')
        return listCategories(deps, spaceId, opts?.includeArchived ?? false)
      },
    },
    transactions: {
      async list(opts) {
        need('transactions:read')
        const { transactions, total } = listTransactions(deps, spaceId, {
          limit: Math.min(Math.max(opts?.limit ?? 50, 1), 200),
          offset: Math.max(opts?.offset ?? 0, 0),
          accountId: opts?.accountId,
          categoryId: opts?.categoryId,
          from: opts?.from,
          to: opts?.to,
          q: opts?.q,
        })
        return { transactions, total }
      },
      async get(id) {
        need('transactions:read')
        try {
          return getTransaction(deps, spaceId, id).transaction
        } catch (e) {
          if (e instanceof LedgerError && e.status === 404) return null
          throw e
        }
      },
    },
    balances: {
      async latest() {
        need('balances:read')
        return listAccounts(deps, spaceId).flatMap((a) =>
          a.balanceCents !== null && a.balanceDate
            ? [{ accountId: a.id, balanceCents: a.balanceCents, date: a.balanceDate }]
            : [],
        )
      },
      async history(accountId, opts) {
        need('balances:read')
        try {
          return listBalances(deps, spaceId, accountId).slice(
            0,
            Math.min(Math.max(opts?.limit ?? 400, 1), 400),
          )
        } catch (e) {
          return missing(e)
        }
      },
    },
    spaces: {
      async get() {
        need('spaces:read')
        const s = deps.repos.spaces.findById(spaceId)
        if (!s) throw new PadError(404, 'not_found')
        return { id: s.id, name: s.name, type: s.type, currency: s.currency }
      },
    },
    splits: {
      async sum(opts: SplitSumOptions) {
        need('transactions:read')
        if (
          !isoDateSchema.safeParse(opts.from).success ||
          !isoDateSchema.safeParse(opts.to).success
        ) {
          throw new PadError(400, 'invalid_dates')
        }
        if (!['category', 'month', 'category_month'].includes(opts.groupBy))
          throw new PadError(400, 'invalid_group')
        return deps.repos.reports.sumSplits(spaceId, opts)
      },
    },
  }
}
