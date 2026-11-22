import type Database from 'better-sqlite3'

/**
 * Representative data for each released schema version. The migration test builds a database
 * at version N, runs `seed`, upgrades to the latest schema, then runs `verify`.
 *
 * WHEN YOU ADD A MIGRATION you must add the next entry here (the test fails until you do):
 *   - `seed`   inserts realistic rows into the tables as they exist at that version
 *   - `verify` asserts that data is still there, intact, after upgrading to the latest schema
 * Use raw SQL, not Drizzle's current schema, so the fixture stays true to that version.
 */
export interface SchemaFixture {
  version: number
  description: string
  seed(db: Database.Database): void
  verify(db: Database.Database): void
}

const one = <T>(db: Database.Database, sql: string, ...params: unknown[]) =>
  db.prepare(sql).get(...params) as T

export const SCHEMA_FIXTURES: SchemaFixture[] = [
  {
    version: 1,
    description: 'M0: only the settings table',
    seed(db) {
      db.prepare(
        "INSERT INTO settings (scope, scope_id, key, value) VALUES ('global', '', 'timezone', '\"America/New_York\"')",
      ).run()
    },
    verify(db) {
      const row = one<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'timezone'")
      if (row.value !== '"America/New_York"') throw new Error(`settings row changed: ${row.value}`)
    },
  },
  {
    version: 2,
    description: 'M1: identity (users, sessions, spaces, members, audit log, recovery codes)',
    seed(db) {
      db.exec(`
        INSERT INTO users (id, username, display_name, password_hash, is_admin, status)
          VALUES ('u1', 'admin', 'Admin', '$argon2id$stub', 1, 'active');
        INSERT INTO spaces (id, name, type, currency) VALUES ('s1', 'Home', 'personal', 'USD');
        INSERT INTO space_members (space_id, user_id, role) VALUES ('s1', 'u1', 'owner');
        INSERT INTO sessions (id, user_id, csrf_hash, expires_at, absolute_expires_at, last_seen_at)
          VALUES ('sess1', 'u1', 'h', '2030-01-01T00:00:00Z', '2030-02-01T00:00:00Z', '2030-01-01T00:00:00Z');
        INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('rc1', 'u1', 'hash');
        INSERT INTO audit_log (id, at, actor_type, actor_id, action)
          VALUES ('a1', '2030-01-01T00:00:00Z', 'user', 'u1', 'auth.login');
      `)
    },
    verify(db) {
      const u = one<{ username: string; is_admin: number }>(
        db,
        "SELECT username, is_admin FROM users WHERE id = 'u1'",
      )
      if (u.username !== 'admin' || u.is_admin !== 1) throw new Error('user row changed')
      const m = one<{ role: string }>(
        db,
        "SELECT role FROM space_members WHERE space_id = 's1' AND user_id = 'u1'",
      )
      if (m.role !== 'owner') throw new Error('membership changed')
      for (const t of ['sessions', 'recovery_codes', 'audit_log', 'spaces']) {
        const n = one<{ n: number }>(db, `SELECT count(*) AS n FROM ${t}`).n
        if (n !== 1) throw new Error(`${t} lost or gained rows: ${n}`)
      }
    },
  },
  {
    version: 3,
    description:
      'M2: ledger (accounts, transactions, splits, categories, transfer links, balances)',
    seed(db) {
      db.exec(`
        INSERT INTO users (id, username, display_name, password_hash, is_admin, status)
          VALUES ('u1', 'admin', 'Admin', '$argon2id$stub', 1, 'active');
        INSERT INTO spaces (id, name, type, currency) VALUES ('s1', 'Home', 'personal', 'USD');
        INSERT INTO accounts (id, name, type, currency, primary_space_id, is_manual)
          VALUES ('acc1', 'Checking', 'checking', 'USD', 's1', 1), ('acc2', 'Savings', 'savings', 'USD', 's1', 1);
        INSERT INTO categories (id, space_id, name, kind) VALUES ('cat1', 's1', 'Groceries', 'expense');
        INSERT INTO transactions (id, account_id, source, date, amount_cents, description_raw)
          VALUES ('t1', 'acc1', 'manual', '2030-01-05', -12500, 'Market'),
                 ('t2', 'acc1', 'manual', '2030-01-06', -50000, 'To savings'),
                 ('t3', 'acc2', 'manual', '2030-01-06', 50000, 'From checking');
        INSERT INTO splits (id, transaction_id, space_id, category_id, amount_cents)
          VALUES ('sp1', 't1', 's1', 'cat1', -7500), ('sp2', 't1', 's1', NULL, -5000),
                 ('sp3', 't2', 's1', NULL, -50000), ('sp4', 't3', 's1', NULL, 50000);
        INSERT INTO transfer_links (id, from_transaction_id, to_transaction_id, created_by)
          VALUES ('l1', 't2', 't3', 'user');
        INSERT INTO balance_snapshots (id, account_id, date, balance_cents, source)
          VALUES ('b1', 'acc1', '2030-01-06', 150000, 'manual');
      `)
    },
    verify(db) {
      const t = one<{ n: number; total: number }>(
        db,
        "SELECT count(*) AS n, sum(amount_cents) AS total FROM splits WHERE transaction_id = 't1'",
      )
      if (t.n !== 2 || t.total !== -12500)
        throw new Error(`splits of t1 changed: ${JSON.stringify(t)}`)
      const link = one<{ from_transaction_id: string }>(
        db,
        "SELECT from_transaction_id FROM transfer_links WHERE id = 'l1'",
      )
      if (link.from_transaction_id !== 't2') throw new Error('transfer link changed')
      const b = one<{ balance_cents: number }>(
        db,
        "SELECT balance_cents FROM balance_snapshots WHERE id = 'b1'",
      )
      if (b.balance_cents !== 150000) throw new Error('balance snapshot changed')
      for (const [table, expected] of [
        ['accounts', 2],
        ['transactions', 3],
        ['categories', 1],
      ] as const) {
        const n = one<{ n: number }>(db, `SELECT count(*) AS n FROM ${table}`).n
        if (n !== expected) throw new Error(`${table} lost or gained rows: ${n}`)
      }
    },
  },
  {
    version: 4,
    description: 'M3: SimpleFIN (connections, synced accounts, user_edited flag)',
    seed(db) {
      db.exec(`
        INSERT INTO users (id, username, display_name, password_hash, is_admin, status)
          VALUES ('u1', 'admin', 'Admin', '$argon2id$stub', 1, 'active');
        INSERT INTO spaces (id, name, type, currency) VALUES ('s1', 'Home', 'personal', 'USD');
        INSERT INTO connections (id, label, access_url_enc, created_by, status, last_synced_at)
          VALUES ('c1', 'My bank', 'v1:stub:stub', 'u1', 'active', '2030-01-05T00:00:00Z');
        INSERT INTO accounts (id, name, type, currency, primary_space_id, is_manual, connection_id, external_id, sync_enabled)
          VALUES ('acc1', 'Bank Checking', 'checking', 'USD', 's1', 0, 'c1', 'ACT-1', 1);
        INSERT INTO transactions (id, account_id, external_id, source, date, amount_cents, description_raw, user_edited, superseded_by)
          VALUES ('t1', 'acc1', 'TX-1', 'simplefin', '2030-01-04', -4200, 'COFFEE', 1, 'newer');
        INSERT INTO splits (id, transaction_id, space_id, amount_cents) VALUES ('sp1', 't1', 's1', -4200);
      `)
    },
    verify(db) {
      const c = one<{ status: string; access_url_enc: string }>(
        db,
        "SELECT status, access_url_enc FROM connections WHERE id = 'c1'",
      )
      if (c.status !== 'active' || c.access_url_enc !== 'v1:stub:stub')
        throw new Error('connection changed')
      const a = one<{ connection_id: string; external_id: string }>(
        db,
        "SELECT connection_id, external_id FROM accounts WHERE id = 'acc1'",
      )
      if (a.connection_id !== 'c1' || a.external_id !== 'ACT-1')
        throw new Error('synced account changed')
      const t = one<{ user_edited: number; amount_cents: number }>(
        db,
        "SELECT user_edited, amount_cents FROM transactions WHERE id = 't1'",
      )
      if (t.user_edited !== 1 || t.amount_cents !== -4200)
        throw new Error('synced transaction changed')
    },
  },
]
