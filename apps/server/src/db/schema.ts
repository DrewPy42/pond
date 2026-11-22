import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * M0 ships only the platform `settings` table, to prove migrations run. Core tables arrive
 * with their milestones (see docs/scope-v1.md).
 *
 * `scope_id` is NOT NULL with '' meaning "global", because SQLite treats NULLs as distinct in
 * primary keys. (Divergence from data-model.md's `scope_id?`; see docs/decisions.md.)
 */
export const settings = sqliteTable(
  'settings',
  {
    scope: text('scope', { enum: ['global', 'space', 'user'] }).notNull(),
    scopeId: text('scope_id').notNull().default(''),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.scopeId, t.key] }),
    index('settings_key_idx').on(t.key),
  ],
)

const nowSql = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
const createdAt = () => text('created_at').notNull().default(nowSql)
const updatedAt = () => text('updated_at').notNull().default(nowSql)

// ---------- Identity and access (M1) ----------

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    email: text('email'),
    passwordHash: text('password_hash').notNull(),
    /** Encrypted with the core crypto module. Never returned from the API. */
    totpSecretEnc: text('totp_secret_enc'),
    /** Set once the user proves they can generate a code; before that TOTP is only pending. */
    totpEnabledAt: text('totp_enabled_at'),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    lastLoginAt: text('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_username_unique').on(t.username)],
)

/** One-time TOTP recovery codes. Only a hash is stored. */
export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: text('code_hash').notNull(),
    usedAt: text('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
)

export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 of the session token; the token itself is never stored. */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /** SHA-256 of the CSRF token paired with this session (double-submit check). */
    csrfHash: text('csrf_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
    absoluteExpiresAt: text('absolute_expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    reauthAt: text('reauth_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export const spaces = sqliteTable('spaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['personal', 'business'] }).notNull(),
  currency: text('currency').notNull().default('USD'),
  archivedAt: text('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const spaceMembers = sqliteTable(
  'space_members',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => spaces.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner', 'editor', 'viewer'] }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.userId] }),
    index('space_members_user_idx').on(t.userId),
  ],
)

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    at: text('at').notNull(),
    actorType: text('actor_type', { enum: ['user', 'system', 'lilypad'] }).notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    spaceId: text('space_id'),
    /** JSON. Never secrets. */
    meta: text('meta', { mode: 'json' }),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_action_idx').on(t.action)],
)

// ---------- Ledger (M2) ----------
// Money columns are signed INTEGER cents; positive = money into the account (CLAUDE.md rule 2).
// `connection_id` / `import_batch_id` arrive with SimpleFIN (M3) and CSV import (M4) as
// ADD COLUMN migrations, because those parent tables don't exist yet.

// ---------- SimpleFIN connections (M3) ----------

export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  /**
   * The SimpleFIN Access URL (it contains credentials), encrypted with the core crypto module.
   * Null once the connection is revoked. Never returned from the API, never logged.
   */
  accessUrlEnc: text('access_url_enc'),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  status: text('status', { enum: ['active', 'error', 'revoked'] })
    .notNull()
    .default('active'),
  lastSyncedAt: text('last_synced_at'),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id').references(() => connections.id),
    /** SimpleFIN's own account id. */
    externalId: text('external_id'),
    institutionName: text('institution_name'),
    name: text('name').notNull(),
    nickname: text('nickname'),
    type: text('type', {
      enum: [
        'checking',
        'savings',
        'credit_card',
        'loan',
        'brokerage',
        'retirement',
        'cash',
        'property',
        'other',
      ],
    }).notNull(),
    currency: text('currency').notNull().default('USD'),
    primarySpaceId: text('primary_space_id').references(() => spaces.id),
    isManual: integer('is_manual', { mode: 'boolean' }).notNull().default(true),
    includeInNetWorth: integer('include_in_net_worth', { mode: 'boolean' }).notNull().default(true),
    syncEnabled: integer('sync_enabled', { mode: 'boolean' }).notNull().default(false),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    lastFour: text('last_four'),
    archivedAt: text('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('accounts_space_idx').on(t.primarySpaceId),
    uniqueIndex('accounts_connection_external_unique')
      .on(t.connectionId, t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
)

export const balanceSnapshots = sqliteTable(
  'balance_snapshots',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    /** Calendar day, YYYY-MM-DD. */
    date: text('date').notNull(),
    balanceCents: integer('balance_cents').notNull(),
    availableCents: integer('available_cents'),
    source: text('source', { enum: ['sync', 'manual'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('balance_snapshots_account_date_unique').on(t.accountId, t.date)],
)

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => spaces.id),
    parentId: text('parent_id'),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['income', 'expense', 'transfer'] }).notNull(),
    taxLine: text('tax_line'),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: text('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('categories_space_idx').on(t.spaceId)],
)

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    /** The bank's own id (SimpleFIN) for de-duplication; null for manual entries. */
    externalId: text('external_id'),
    source: text('source', { enum: ['simplefin', 'manual', 'csv'] }).notNull(),
    /** Calendar day, YYYY-MM-DD. */
    date: text('date').notNull(),
    postedAt: text('posted_at'),
    transactedAt: text('transacted_at'),
    amountCents: integer('amount_cents').notNull(),
    descriptionRaw: text('description_raw').notNull(),
    payee: text('payee'),
    memo: text('memo'),
    pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['active', 'removed'] })
      .notNull()
      .default('active'),
    /** Cross-Space privacy (data-model.md): hides account name, total and other splits. */
    private: integer('private', { mode: 'boolean' }).notNull().default(false),
    needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
    /** True once a person changed it; sync won't remove or overwrite what they edited. */
    userEdited: integer('user_edited', { mode: 'boolean' }).notNull().default(false),
    /** For a pending transaction that the bank replaced with a posted one: that posted one's id. */
    supersededBy: text('superseded_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('transactions_account_date_idx').on(t.accountId, t.date),
    uniqueIndex('transactions_account_external_unique')
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
)

export const splits = sqliteTable(
  'splits',
  {
    id: text('id').primaryKey(),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id),
    spaceId: text('space_id')
      .notNull()
      .references(() => spaces.id),
    categoryId: text('category_id').references(() => categories.id),
    amountCents: integer('amount_cents').notNull(),
    memo: text('memo'),
    reimbursable: integer('reimbursable', { mode: 'boolean' }).notNull().default(false),
    reimbursedAt: text('reimbursed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('splits_txn_idx').on(t.transactionId), index('splits_space_idx').on(t.spaceId)],
)

export const transferLinks = sqliteTable(
  'transfer_links',
  {
    id: text('id').primaryKey(),
    fromTransactionId: text('from_transaction_id')
      .notNull()
      .references(() => transactions.id),
    toTransactionId: text('to_transaction_id')
      .notNull()
      .references(() => transactions.id),
    createdBy: text('created_by', { enum: ['user', 'rule', 'auto'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // A transaction can be on at most one side of one link.
    uniqueIndex('transfer_links_from_unique').on(t.fromTransactionId),
    uniqueIndex('transfer_links_to_unique').on(t.toTransactionId),
  ],
)
