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
