import { describe, expect, it } from 'vitest'
import { openDb } from './index'

// Real SQLite on purpose: this checks the connection settings themselves.
describe('openDb(path)', () => {
  /**
   * Function: openDb(":memory:")
   * Inputs:   a new in-memory database
   * Expected: foreign keys are enforced (pragma foreign_keys = 1), which the repositories and
   *           the "refuses a session for an unknown user" contract test rely on
   */
  it('turns on foreign key enforcement', () => {
    const h = openDb(':memory:')
    expect(h.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    h.close()
  })
})
