import { describe, expect, it } from 'vitest'
import { newId } from './ids'

describe('newId()', () => {
  /**
   * Function: newId()
   * Inputs:   two ids generated one after the other
   * Expected: both are valid UUIDv7 strings (CLAUDE.md rule 4) and the second sorts after the
   *           first, so ids order by creation time
   */
  it('generates UUIDv7 ids that sort by creation time', () => {
    const a = newId()
    const b = newId()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a < b).toBe(true)
  })
})
