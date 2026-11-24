import { describe, expect, it } from 'vitest'
import {
  PadSchemaError,
  applyOps,
  checkRow,
  collectOps,
  defineMigration,
  normalizeWhere,
  schemaFromMigrations,
  valueFits,
} from './data'
import { manifestSchema } from './manifest'
import { PERMISSIONS, describePermission, satisfiesRange, touchesFinances } from './permissions'

const migrate = (fn: Parameters<typeof defineMigration>[1]) => defineMigration('m', fn)

describe('satisfiesRange(version, range)', () => {
  /**
   * Inputs:   "1.0.0" and "1.4.2" against "^1.0" and "^1.2.1"; "2.0.0" against "^1.0"; "1.0.0" against "^1.1"
   * Expected: true, true, true, false (different major), false (older than the range)
   */
  it('accepts versions with the same major that are new enough', () => {
    expect(satisfiesRange('1.0.0', '^1.0')).toBe(true)
    expect(satisfiesRange('1.4.2', '^1.0')).toBe(true)
    expect(satisfiesRange('1.4.2', '^1.2.1')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.0')).toBe(false)
    expect(satisfiesRange('1.0.0', '^1.1')).toBe(false)
  })
  /**
   * Inputs:   exact "1.0.0" vs "1.0.0" and "1.0.1"; ranges we don't support (">=1", "1.x", "*", "~1.0"); a bad version
   * Expected: true, false; false for every unsupported form (refused rather than guessed)
   */
  it('supports exact versions and refuses unsupported range forms', () => {
    expect(satisfiesRange('1.0.0', '1.0.0')).toBe(true)
    expect(satisfiesRange('1.0.0', '1.0.1')).toBe(false)
    for (const r of ['>=1', '1.x', '*', '~1.0']) expect(satisfiesRange('1.0.0', r), r).toBe(false)
    expect(satisfiesRange('1.0', '^1.0')).toBe(false)
  })
})

describe('permissions', () => {
  /**
   * Inputs:   every permission
   * Expected: each has a plain-language description; only the finance ones count as touching finances
   */
  it('has words for each permission and knows which touch finances', () => {
    for (const p of PERMISSIONS) expect(describePermission(p).length, p).toBeGreaterThan(5)
    expect(touchesFinances([])).toBe(false)
    expect(touchesFinances(['secrets:use', 'files:store'])).toBe(false)
    expect(touchesFinances(['balances:read'])).toBe(true)
  })
})

describe('manifestSchema', () => {
  const ok = {
    id: 'notes',
    name: 'Notes',
    version: '1.0.0',
    author: 'WibbitWorks',
    license: 'MIT',
    pondApi: '^1.0',
    spaceTypes: ['personal'],
    permissions: [],
  }
  /**
   * Inputs:   a minimal manifest; one with uppercase in the id; an unknown permission; no space types;
   *           a bad version
   * Expected: accepted (settings default to []); all others rejected
   */
  it('validates the manifest fields', () => {
    expect(manifestSchema.safeParse(ok).success).toBe(true)
    expect(manifestSchema.safeParse({ ...ok, id: 'Notes' }).success).toBe(false)
    expect(manifestSchema.safeParse({ ...ok, permissions: ['everything'] }).success).toBe(false)
    expect(manifestSchema.safeParse({ ...ok, spaceTypes: [] }).success).toBe(false)
    expect(manifestSchema.safeParse({ ...ok, version: '1.0' }).success).toBe(false)
  })
})

describe('migrations: collectOps / applyOps / schemaFromMigrations', () => {
  /**
   * Inputs:   a migration creating a table with shorthand and full column definitions, then another adding a column
   * Expected: the schema has the tables and columns in order; space scope is the default
   */
  it('builds a schema from migrations', () => {
    const s = schemaFromMigrations([
      defineMigration('0001', (m) =>
        m.createTable('notes', { columns: { title: 'text', n: { type: 'integer', default: 0 } } }),
      ),
      defineMigration('0002', (m) =>
        m.addColumn('notes', 'body', { type: 'text', nullable: true }),
      ),
    ])
    expect(s.notes!.scope).toBe('space')
    expect(Object.keys(s.notes!.columns)).toEqual(['title', 'n', 'body'])
  })
  /**
   * Inputs:   bad table and column names; reserved column names (id, space_id); an unknown table; a duplicate
   *           table; a non-nullable added column with no default; a default of the wrong type; an index on an
   *           unknown column; duplicate migration names
   * Expected: PadSchemaError for each
   */
  it('refuses unsafe or inconsistent migrations', () => {
    const bad = (fn: Parameters<typeof defineMigration>[1]) => () =>
      applyOps({}, collectOps(migrate(fn)))
    expect(bad((m) => m.createTable('Bad-Name', { columns: { a: 'text' } }))).toThrow(
      PadSchemaError,
    )
    expect(bad((m) => m.createTable('t', { columns: { 'a b': 'text' } }))).toThrow(PadSchemaError)
    expect(bad((m) => m.createTable('t', { columns: { id: 'text' } }))).toThrow(PadSchemaError)
    expect(bad((m) => m.createTable('t', { columns: { space_id: 'text' } }))).toThrow(
      PadSchemaError,
    )
    expect(bad((m) => m.addColumn('missing', 'a', 'text'))).toThrow(PadSchemaError)
    expect(
      bad((m) => {
        m.createTable('t', { columns: { a: 'text' } })
        m.createTable('t', { columns: { a: 'text' } })
      }),
    ).toThrow(PadSchemaError)
    expect(
      bad((m) => {
        m.createTable('t', { columns: { a: 'text' } })
        m.addColumn('t', 'b', 'text')
      }),
    ).toThrow(PadSchemaError)
    expect(
      bad((m) => m.createTable('t', { columns: { a: { type: 'integer', default: 'x' } } })),
    ).toThrow(PadSchemaError)
    expect(
      bad((m) => m.createTable('t', { columns: { a: 'text' }, indexes: [{ columns: ['zzz'] }] })),
    ).toThrow(PadSchemaError)
    expect(() =>
      schemaFromMigrations([defineMigration('x', () => {}), defineMigration('x', () => {})]),
    ).toThrow(PadSchemaError)
  })
})

describe('normalizeWhere / checkRow / valueFits', () => {
  const schema = schemaFromMigrations([
    defineMigration('0', (m) =>
      m.createTable('t', {
        columns: {
          title: 'text',
          n: 'integer',
          ok: 'boolean',
          tags: { type: 'json', nullable: true },
        },
      }),
    ),
  ]).t!
  /**
   * Inputs:   a clause mixing equality, an operator object and $or
   * Expected: a predicate tree with the equality, the operators and the or-branches
   */
  it('turns a where clause into a predicate tree', () => {
    const n = normalizeWhere(schema, {
      title: 'a',
      n: { gt: 1, lte: 5 },
      $or: [{ ok: true }, { ok: false }],
    })
    expect(n.preds).toEqual([
      { col: 'title', op: 'eq', value: 'a' },
      { col: 'n', op: 'gt', value: 1 },
      { col: 'n', op: 'lte', value: 5 },
    ])
    expect(n.or).toHaveLength(2)
  })
  /**
   * Inputs:   null equality; "in" with a wrong-typed member; an empty $or; $or nested deeper than allowed
   * Expected: null equality becomes isNull; the others throw PadDataError
   */
  it('handles null and refuses malformed clauses', () => {
    expect(normalizeWhere(schema, { title: null }).preds).toEqual([{ col: 'title', op: 'isNull' }])
    expect(() => normalizeWhere(schema, { n: { in: [1, 'x'] } })).toThrow()
    expect(() => normalizeWhere(schema, { $or: [] })).toThrow()
    expect(() =>
      normalizeWhere(schema, { $or: [{ $or: [{ $or: [{ $or: [{ n: 1 }] }] }] }] }),
    ).toThrow()
  })
  /**
   * Inputs:   rows for insert (complete and incomplete) and patches
   * Expected: insert needs every non-nullable column; patches may be partial; wrong types are refused
   */
  it('checks rows for insert and patch', () => {
    expect(checkRow(schema, { title: 'a', n: 1, ok: true }, 'insert')).toEqual({
      title: 'a',
      n: 1,
      ok: true,
      tags: null,
    })
    expect(() => checkRow(schema, { title: 'a' }, 'insert')).toThrow()
    expect(checkRow(schema, { n: 2 }, 'patch')).toEqual({ n: 2 })
    expect(() => checkRow(schema, { n: '2' }, 'patch')).toThrow()
  })
  /**
   * Inputs:   values against each column type; an unsafe integer; an over-long text; a circular json value
   * Expected: matching types fit, mismatches and oversize do not; null only for nullable
   */
  it('knows which values fit which column types', () => {
    expect(valueFits({ type: 'integer' }, 5)).toBe(true)
    expect(valueFits({ type: 'integer' }, 2 ** 60)).toBe(false)
    expect(valueFits({ type: 'text' }, 'x'.repeat(100_001))).toBe(false)
    expect(valueFits({ type: 'json' }, { a: [1, 2] })).toBe(true)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(valueFits({ type: 'json' }, circular)).toBe(false)
    expect(valueFits({ type: 'text' }, null)).toBe(false)
    expect(valueFits({ type: 'text', nullable: true }, null)).toBe(true)
  })
})
