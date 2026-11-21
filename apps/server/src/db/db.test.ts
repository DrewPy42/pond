import { describe, expect, it } from 'vitest'
import { openDb, runMigrations, schemaVersion } from './index'
import { newId } from './ids'

describe('database', () => {
  it('runs migrations on an empty database and is idempotent', () => {
    const h = openDb(':memory:')
    expect(schemaVersion(h)).toBe(0)
    runMigrations(h)
    const v = schemaVersion(h)
    expect(v).toBeGreaterThan(0)
    runMigrations(h)
    expect(schemaVersion(h)).toBe(v)
    const tables = h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string
    }[]
    expect(tables.map((t) => t.name)).toContain('settings')
    h.close()
  })
  it('enforces foreign keys', () => {
    const h = openDb(':memory:')
    expect(h.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    h.close()
  })
  it('generates UUIDv7 ids that sort by creation time', () => {
    const a = newId()
    const b = newId()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a < b).toBe(true)
  })
})
