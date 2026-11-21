import { sql } from 'drizzle-orm'
import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
