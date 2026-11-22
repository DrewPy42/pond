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
]
