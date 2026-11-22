import { describe, expect, it } from 'vitest'
import { SCHEMA_FIXTURES } from './fixtures'
import { openDb, runMigrations, schemaVersion } from './index'
import { latestSchemaVersion, migrateToVersion } from './migrationTesting'

/**
 * Migrations are forward-only and must work on a database restored from an older backup
 * (CLAUDE.md rule 9). Each test below recreates "an install on an older release" and upgrades it.
 */
describe('database migrations (upgrade from older schema versions)', () => {
  /**
   * Function: runMigrations(handle)
   * Inputs:   a database at schema version N holding sample data (see fixtures.ts), for every N
   * Expected: ends at the latest schema version, and every sample row is still present and equal
   */
  it.each(SCHEMA_FIXTURES.map((f) => [f.version, f.description, f] as const))(
    'upgrading from schema v%i (%s) keeps its data',
    (_version, _description, fixture) => {
      const h = openDb(':memory:')
      migrateToVersion(h, fixture.version)
      expect(schemaVersion(h)).toBe(fixture.version)
      fixture.seed(h.sqlite)

      runMigrations(h)

      expect(schemaVersion(h)).toBe(latestSchemaVersion())
      expect(() => fixture.verify(h.sqlite)).not.toThrow()
      h.close()
    },
  )

  /**
   * Function: SCHEMA_FIXTURES (guard), latestSchemaVersion()
   * Inputs:   the list of migrations in drizzle/meta/_journal.json and the list of fixtures
   * Expected: one fixture per migration, numbered 1..latest. This fails when someone adds a
   *           migration without adding a fixture, which is the point.
   */
  it('has a fixture for every migration that ships', () => {
    const versions = SCHEMA_FIXTURES.map((f) => f.version)
    const expected = Array.from({ length: latestSchemaVersion() }, (_, i) => i + 1)
    expect(versions).toEqual(expected)
  })

  /**
   * Function: runMigrations(handle)
   * Inputs:   a database that is already at the latest schema
   * Expected: no error and no change (running twice is safe, e.g. after a restart)
   */
  it('is a no-op when already up to date', () => {
    const h = openDb(':memory:')
    runMigrations(h)
    const before = schemaVersion(h)
    expect(() => runMigrations(h)).not.toThrow()
    expect(schemaVersion(h)).toBe(before)
    h.close()
  })
})
