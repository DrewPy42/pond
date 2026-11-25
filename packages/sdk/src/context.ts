import type { AccountView, BalanceView, CategoryView, TransactionView } from '@pond/shared'
import type { ZodType } from 'zod'
import type { Migration, TableApi, Row } from './data.js'
import type { PadDownload, UploadSpec, UploadedFile } from './files.js'
import type { PadManifest } from './manifest.js'

/** Roles a route can require. Space owners and admins satisfy every role. */
export type Role = 'viewer' | 'editor' | 'owner'

export interface ScopeUser {
  id: string
  username: string
  displayName: string
}

// ---------- What a pad may read from core (all bound to one Space) ----------

export interface SplitSumRow {
  categoryId: string | null
  /** The category's kind, or null for uncategorized splits. */
  kind: 'income' | 'expense' | 'transfer' | null
  /** YYYY-MM, when grouped by month. */
  month: string | null
  /** Signed integer cents: positive = money in. */
  cents: number
  count: number
}
export interface SplitSumOptions {
  /** Inclusive calendar days, YYYY-MM-DD. */
  from: string
  to: string
  groupBy: 'category' | 'month' | 'category_month'
  categoryIds?: string[]
  /** Defaults to ["transfer"]: transfers are never spending or income. */
  excludeKinds?: ('income' | 'expense' | 'transfer')[]
}
export interface TransactionListOptions {
  accountId?: string
  categoryId?: string
  from?: string
  to?: string
  q?: string
  limit?: number
  offset?: number
}

/** A transaction as a pad sees it. `linkedTransfer`: one side of a transfer, so never income or spending. */
export type PadTransaction = TransactionView & { linkedTransfer: boolean }

/** Requires the matching permission, and returns privacy-filtered views (the same as the web app sees). */
export interface ScopedCore {
  accounts: { list(): Promise<AccountView[]> }
  categories: { list(opts?: { includeArchived?: boolean }): Promise<CategoryView[]> }
  transactions: {
    list(opts?: TransactionListOptions): Promise<{ transactions: PadTransaction[]; total: number }>
    get(id: string): Promise<PadTransaction | null>
  }
  balances: {
    latest(): Promise<{ accountId: string; balanceCents: number; date: string }[]>
    history(accountId: string, opts?: { limit?: number }): Promise<BalanceView[]>
  }
  spaces: {
    get(): Promise<{ id: string; name: string; type: 'personal' | 'business'; currency: string }>
  }
  splits: { sum(opts: SplitSumOptions): Promise<SplitSumRow[]> }
}

export interface PadDb {
  /** Only this pad's own tables, as declared in its migrations. */
  table<R extends Row = Row>(name: string): TableApi<R>
}

export interface PadSettings {
  /** The value for the current Space (or the global value), falling back to the default. */
  get<T extends string | number | boolean = string | number | boolean>(key: string): Promise<T>
  /** Space settings only, and only from a request by a Space owner. */
  set(key: string, value: string | number | boolean): Promise<void>
}
export interface PadSecrets {
  encrypt(plaintext: string): Promise<string>
  decrypt(stored: string): Promise<string>
}
export interface PadAudit {
  /** Recorded as `lilypad.<id>.<action>`, attributed to the pad. Never put secrets in `meta`. */
  record(entry: {
    action: string
    targetType?: string
    targetId?: string
    meta?: Record<string, string | number | boolean | null>
  }): Promise<void>
}
export interface PadLog {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

/** The pad's own files in this Space (needs `files:store`). Files arrive through upload routes. */
export interface PadFiles {
  /** Return this from a route to send the file as a download. */
  download(fileId: string, filename: string): Promise<PadDownload>
  /** Deleting a file that is already gone is fine. */
  remove(fileId: string): Promise<void>
}

/** What every handler (route, event, job) is given. */
export interface PadScope {
  padId: string
  space: { id: string; type: 'personal' | 'business'; role: Role | null }
  /** The person making the request; null in event handlers and scheduled jobs. */
  user: ScopeUser | null
  core: ScopedCore
  db: PadDb
  settings: PadSettings
  secrets: PadSecrets
  files: PadFiles
  audit: PadAudit
  log: PadLog
  newId(): string
}

// ---------- Registering behavior ----------

export type PadRequest<B = unknown, Q = unknown> = PadScope & {
  params: Record<string, string>
  query: Q
  body: B
  /** Set on routes that declare `upload`. */
  file?: UploadedFile
}
export interface RouteOptions<B = unknown, Q = unknown> {
  /** The least role allowed. There is no default: every route must say. */
  role: Role
  /** Validated before the handler runs; a failure is a 400. */
  body?: ZodType<B>
  query?: ZodType<Q>
  /**
   * The request body is a file (POST or PUT only; send details in the query string). It can't be
   * combined with `body`. If the handler throws, the stored file is deleted.
   */
  upload?: UploadSpec
  /**
   * Require the person to have entered their password in the last 5 minutes. Pond asks them
   * itself; the pad never sees it. Every successful call is written to the audit log.
   */
  reauth?: boolean
}
/** Return JSON-serializable data. Throw `PadError` for an expected failure. */
export type RouteHandler<B = unknown, Q = unknown> = (
  req: PadRequest<B, Q>,
) => unknown | Promise<unknown>

export interface PadRouter {
  get<B = unknown, Q = unknown>(
    path: string,
    opts: RouteOptions<B, Q>,
    handler: RouteHandler<B, Q>,
  ): void
  post<B = unknown, Q = unknown>(
    path: string,
    opts: RouteOptions<B, Q>,
    handler: RouteHandler<B, Q>,
  ): void
  put<B = unknown, Q = unknown>(
    path: string,
    opts: RouteOptions<B, Q>,
    handler: RouteHandler<B, Q>,
  ): void
  patch<B = unknown, Q = unknown>(
    path: string,
    opts: RouteOptions<B, Q>,
    handler: RouteHandler<B, Q>,
  ): void
  delete<B = unknown, Q = unknown>(
    path: string,
    opts: RouteOptions<B, Q>,
    handler: RouteHandler<B, Q>,
  ): void
}

/** Thrown by the host when a pad uses core data it was not granted permission for. */
export class PadPermissionError extends Error {
  constructor(public permission: string) {
    super(`This pad was not granted the "${permission}" permission`)
  }
}

/** An expected failure a handler wants to report: becomes an HTTP error with this status and code. */
export class PadError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    public code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}

export type PadEvent =
  | { type: 'transaction.created'; spaceId: string; transactionId: string }
  | { type: 'transaction.updated'; spaceId: string; transactionId: string }
  | { type: 'split.changed'; spaceId: string; transactionId: string }
  | { type: 'account.added'; spaceId: string; accountId: string }
  | { type: 'sync.completed'; spaceId: string }
  | { type: 'space.created'; spaceId: string }
export type PadEventType = PadEvent['type']
export const EVENT_TYPES: PadEventType[] = [
  'transaction.created',
  'transaction.updated',
  'split.changed',
  'account.added',
  'sync.completed',
  'space.created',
]

/** Structured schedules (amendment A3): no cron strings. `at` is local time, "HH:MM". */
export type Schedule =
  | { daily: { at: string } }
  | { weekly: { day: 0 | 1 | 2 | 3 | 4 | 5 | 6; at: string } }
  | { monthly: { day: number; at: string } }

/** Registered once when the pad starts. Handlers get a fresh scope each time they run. */
export interface PadContext {
  manifest: PadManifest
  router: PadRouter
  events: {
    on<T extends PadEventType>(
      type: T,
      handler: (event: Extract<PadEvent, { type: T }>, scope: PadScope) => Promise<void> | void,
    ): void
  }
  /** Runs once per Space where the pad is enabled. */
  jobs: {
    schedule(
      name: string,
      schedule: Schedule,
      handler: (scope: PadScope) => Promise<void> | void,
    ): void
  }
  log: PadLog
}

export interface PadDefinition {
  register(ctx: PadContext): void | Promise<void>
}
export const definePad = (def: PadDefinition): PadDefinition => def

/** What a pad's package exports for the host's registry. */
export interface PadModule {
  manifest: PadManifest
  migrations: Migration[]
  server: PadDefinition
}
export const definePadModule = (m: PadModule): PadModule => m
