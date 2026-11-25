import { applyOps, collectOps, type PadSchema } from '@pond/sdk'
import { describe, expect, it } from 'vitest'
import { openDb } from '../db/index'
import { registrySource } from '../lilypads/registry'
import { createSqlitePadStore } from './padStore'

// Real SQLite on purpose: these are the tables a real install gets.
describe('official LilyPad migrations on SQLite', () => {
  const build = () => {
    const handle = openDb(':memory:')
    let n = 0
    const store = createSqlitePadStore(handle.sqlite, {
      newId: () => `id-${++n}`,
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    return { handle, store }
  }

  /**
   * Function: every official pad's migrations
   * Inputs:   each shipped pad, in order, on one fresh database
   * Expected: all apply without error, side by side, and create lp_<padId>_ tables only
   */
  it('apply cleanly side by side', () => {
    const { handle, store } = build()
    const tables = () =>
      handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => (r as { name: string }).name)
    const before = new Set(tables())
    for (const pad of registrySource.list())
      for (const m of pad.migrations) store.applyOps(pad.manifest.id, collectOps(m))
    const added = tables().filter((t) => !before.has(t))
    expect(added.every((t) => t.startsWith('lp_'))).toBe(true)
    expect(added).toEqual(
      expect.arrayContaining([
        'lp_business_profile',
        'lp_business_deductions',
        'lp_business_people',
        'lp_business_pay_records',
        'lp_business_documents',
      ]),
    )
  })

  /**
   * Function: the Business pad's one-profile-per-Space rule
   * Inputs:   a profile row in two Spaces, then a second one in the first Space
   * Expected: each Space may have one; the second in the same Space is refused as a duplicate
   */
  it('lets every Space have its own business profile, but only one', async () => {
    const { store } = build()
    const pad = registrySource.list().find((p) => p.manifest.id === 'business')!
    let schema: PadSchema = {}
    for (const m of pad.migrations) {
      schema = applyOps(schema, collectOps(m))
      store.applyOps('business', collectOps(m))
    }
    const profile = (space: string) => store.table('business', schema, 'profile', space)
    await profile('A').insert({ slot: 'profile' })
    await profile('B').insert({ slot: 'profile' })
    await expect(profile('A').insert({ slot: 'profile' })).rejects.toThrow(/duplicate/i)
  })
})
