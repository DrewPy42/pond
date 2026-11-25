import { describe, expect, it } from 'vitest'
import {
  PadDataError,
  applyOps,
  collectOps,
  defineMigration,
  type Migration,
  type PadSchema,
  type PadStore,
  type TableApi,
  type Where,
} from '../data.js'

/**
 * The table API contract. It runs against the in-memory store here (in the SDK) AND against the
 * SQLite store in the server, so a pad written and tested on the fake behaves the same in Pond.
 */
export const CONTRACT_MIGRATIONS: Migration[] = [
  defineMigration('0001_init', (m) => {
    m.createTable('notes', {
      columns: {
        title: 'text',
        body: { type: 'text', nullable: true },
        priority: { type: 'integer', default: 0 },
        done: { type: 'boolean', default: false },
        tags: { type: 'json', nullable: true },
      },
      indexes: [{ columns: ['priority'] }],
    })
    m.createTable('tags', {
      columns: { name: 'text', extra: { type: 'text', nullable: true } },
      indexes: [{ columns: ['name'], unique: true }],
    })
    m.createTable('prefs', {
      scope: 'global',
      columns: { key: 'text', value: 'text' },
      indexes: [{ columns: ['key'], unique: true }],
    })
  }),
]

const PAD = 'contract-pad'

export function tableStoreContract(label: string, make: () => PadStore): void {
  const setup = () => {
    const store = make()
    let schema: PadSchema = {}
    for (const mig of CONTRACT_MIGRATIONS) {
      const ops = collectOps(mig)
      schema = applyOps(schema, ops)
      store.applyOps(PAD, ops)
    }
    const notes = (space = 'S1') => store.table(PAD, schema, 'notes', space)
    return { store, schema, notes, prefs: () => store.table(PAD, schema, 'prefs', null) }
  }
  const code = async (p: Promise<unknown>) => {
    try {
      await p
    } catch (e) {
      return e instanceof PadDataError ? e.code : `other:${(e as Error).message}`
    }
    return 'no error'
  }

  describe(`${label}: table API`, () => {
    /**
     * Function: table.insert(row)
     * Inputs:   a note with only a title in Space S1
     * Expected: the stored row has an id, the Space id "S1", timestamps, and the defaults
     *           (priority 0, done false, body and tags null)
     */
    it('adds the automatic columns and applies defaults', async () => {
      const { notes } = setup()
      const row = await notes().insert({ title: 'Buy milk' })
      expect(row).toMatchObject({
        title: 'Buy milk',
        space_id: 'S1',
        priority: 0,
        done: false,
        body: null,
        tags: null,
      })
      expect(typeof row.id).toBe('string')
      expect(row.created_at).toBeTruthy()
      expect(row.updated_at).toBe(row.created_at)
    })

    /**
     * Function: table.insert(row) (validation)
     * Inputs:   a missing required column; a wrong type; null in a non-nullable column; an unknown
     *           column; writing id, space_id and created_at; a non-integer number
     * Expected: PadDataError "not_nullable", "invalid_value", "not_nullable", "unknown_column",
     *           "invalid_value" (three times), "invalid_value"; nothing is stored
     */
    it('refuses rows that do not fit the table', async () => {
      const { notes } = setup()
      const t = notes()
      expect(await code(t.insert({ body: 'x' }))).toBe('not_nullable')
      expect(await code(t.insert({ title: 5 }))).toBe('invalid_value')
      expect(await code(t.insert({ title: null }))).toBe('not_nullable')
      expect(await code(t.insert({ title: 'a', nope: 1 }))).toBe('unknown_column')
      for (const bad of [{ id: 'x' }, { space_id: 'S2' }, { created_at: 'x' }] as Record<
        string,
        string
      >[]) {
        expect(await code(t.insert({ title: 'a', ...bad })), JSON.stringify(bad)).toBe(
          'invalid_value',
        )
      }
      expect(await code(t.insert({ title: 'a', priority: 1.5 }))).toBe('invalid_value')
      expect(await t.count()).toBe(0)
    })

    const seedNotes = async (t: TableApi) => {
      await t.insertMany([
        { title: 'Alpha plan', priority: 3, done: false, body: 'first' },
        { title: 'beta Notes', priority: 1, done: true, body: null },
        { title: 'Gamma', priority: 2, done: false, body: 'third' },
        { title: 'alphabet soup', priority: 2, done: true, body: 'fourth' },
      ])
    }
    const titles = (rows: { title?: unknown }[]) => rows.map((r) => r.title)

    /**
     * Function: table.find({ where })
     * Inputs:   notes Alpha plan(3), beta Notes(1), Gamma(2), alphabet soup(2); filters: priority
     *           equals 2; ne 2; gt 1; gte 2; lt 2; lte 2; in [1,3]; done true; body isNull; body not null
     * Expected: the matching titles each time, in insertion order (SQL comparison rules: a NULL never
     *           satisfies a comparison)
     */
    it('filters with equality, comparison, in and null tests', async () => {
      const { notes } = setup()
      const t = notes()
      await seedNotes(t)
      const f = async (where: Where) => titles(await t.find({ where }))
      expect(await f({ priority: 2 })).toEqual(['Gamma', 'alphabet soup'])
      expect(await f({ priority: { ne: 2 } })).toEqual(['Alpha plan', 'beta Notes'])
      expect(await f({ priority: { gt: 1 } })).toEqual(['Alpha plan', 'Gamma', 'alphabet soup'])
      expect(await f({ priority: { gte: 2 } })).toEqual(['Alpha plan', 'Gamma', 'alphabet soup'])
      expect(await f({ priority: { lt: 2 } })).toEqual(['beta Notes'])
      expect(await f({ priority: { lte: 2 } })).toEqual(['beta Notes', 'Gamma', 'alphabet soup'])
      expect(await f({ priority: { in: [1, 3] } })).toEqual(['Alpha plan', 'beta Notes'])
      expect(await f({ priority: { in: [] } })).toEqual([])
      expect(await f({ done: true })).toEqual(['beta Notes', 'alphabet soup'])
      expect(await f({ body: null })).toEqual(['beta Notes'])
      expect(await f({ body: { isNull: false } })).toEqual(['Alpha plan', 'Gamma', 'alphabet soup'])
      expect(await f({ body: { ne: 'first' } })).toEqual(['Gamma', 'alphabet soup'])
    })

    /**
     * Function: table.find({ where }) (text search and $or)
     * Inputs:   title contains "ALPHA" (any case); starts with "al"; contains "%" or "_" (literal);
     *           $or of priority 1 and title Gamma; AND of done true with $or of two priorities
     * Expected: case-insensitive matches; wildcard characters in the search text are matched literally
     *           (no match); the OR group and its AND combination work
     */
    it('searches text case-insensitively and supports $or', async () => {
      const { notes } = setup()
      const t = notes()
      await seedNotes(t)
      await t.insert({ title: '100% sure_thing' })
      const f = async (where: Where) => titles(await t.find({ where }))
      expect(await f({ title: { contains: 'ALPHA' } })).toEqual(['Alpha plan', 'alphabet soup'])
      expect(await f({ title: { startsWith: 'al' } })).toEqual(['Alpha plan', 'alphabet soup'])
      expect(await f({ title: { contains: '%' } })).toEqual(['100% sure_thing'])
      expect(await f({ title: { contains: '_th' } })).toEqual(['100% sure_thing'])
      expect(await f({ title: { contains: 'a%b' } })).toEqual([])
      expect(await f({ $or: [{ priority: 1 }, { title: 'Gamma' }] })).toEqual([
        'beta Notes',
        'Gamma',
      ])
      expect(await f({ done: true, $or: [{ priority: 1 }, { priority: 3 }] })).toEqual([
        'beta Notes',
      ])
    })

    /**
     * Function: table.find({ orderBy, limit, offset })
     * Inputs:   order by priority ascending, by priority descending then title ascending, a limit of 2
     *           with an offset of 1, and by body ascending (one body is null)
     * Expected: the expected orders; NULL sorts first when ascending (SQLite's rule); limit and offset page
     */
    it('orders and pages results', async () => {
      const { notes } = setup()
      const t = notes()
      await seedNotes(t)
      expect(titles(await t.find({ orderBy: [['priority', 'asc']] }))).toEqual([
        'beta Notes',
        'Gamma',
        'alphabet soup',
        'Alpha plan',
      ])
      expect(
        titles(
          await t.find({
            orderBy: [
              ['priority', 'desc'],
              ['title', 'asc'],
            ],
          }),
        ),
      ).toEqual(['Alpha plan', 'Gamma', 'alphabet soup', 'beta Notes'])
      expect(titles(await t.find({ orderBy: [['priority', 'asc']], limit: 2, offset: 1 }))).toEqual(
        ['Gamma', 'alphabet soup'],
      )
      expect((await t.find({ orderBy: [['body', 'asc']] }))[0]!.title).toBe('beta Notes')
    })

    /**
     * Function: table.find / count (invalid requests)
     * Inputs:   an unknown column, a json column filter, an unknown operator, "contains" on an integer,
     *           a limit of 0 and of 5000, a bad direction, ordering by an unknown column
     * Expected: PadDataError with "unknown_column", "invalid_where", "invalid_where", "invalid_where",
     *           "invalid_options" twice, "invalid_options", "unknown_column"
     */
    it('refuses invalid filters and options', async () => {
      const { notes } = setup()
      const t = notes()
      expect(await code(t.find({ where: { nope: 1 } }))).toBe('unknown_column')
      expect(await code(t.find({ where: { tags: 'x' } }))).toBe('invalid_where')
      expect(await code(t.find({ where: { title: { like: 'x' } as never } }))).toBe('invalid_where')
      expect(await code(t.find({ where: { priority: { contains: '1' } } }))).toBe('invalid_where')
      expect(await code(t.find({ limit: 0 }))).toBe('invalid_options')
      expect(await code(t.find({ limit: 5000 }))).toBe('invalid_options')
      expect(await code(t.find({ orderBy: [['title', 'sideways' as never]] }))).toBe(
        'invalid_options',
      )
      expect(await code(t.find({ orderBy: [['nope', 'asc']] }))).toBe('unknown_column')
      expect(await code(t.count({ nope: 1 }))).toBe('unknown_column')
    })

    /**
     * Function: automatic Space scoping
     * Inputs:   notes inserted in Spaces S1 and S2; reads, counts, updates and deletes from each Space;
     *           a where clause that names space_id "S2" while in S1
     * Expected: each Space sees only its own rows; an update or delete in S1 never changes S2's rows;
     *           naming another Space in a filter finds nothing (it cannot widen the scope)
     */
    it("keeps each Space's rows separate", async () => {
      const { notes } = setup()
      await notes('S1').insertMany([{ title: 'one' }, { title: 'two' }])
      await notes('S2').insert({ title: 'secret' })
      expect(titles(await notes('S1').find())).toEqual(['one', 'two'])
      expect(titles(await notes('S2').find())).toEqual(['secret'])
      expect(await notes('S1').find({ where: { space_id: 'S2' } })).toEqual([])
      expect(await notes('S1').update({}, { title: 'changed' })).toBe(2)
      expect(await notes('S1').delete({ title: 'secret' })).toBe(0)
      expect(titles(await notes('S2').find())).toEqual(['secret'])
      expect(await notes('S2').count()).toBe(1)
      expect(await notes('S1').delete({})).toBe(2)
      expect(await notes('S2').count()).toBe(1)
    })

    /**
     * Function: table.update(where, patch), table.delete(where), table.findOne, table.count
     * Inputs:   update done on notes with priority 2; try to change id and space_id; delete the done ones;
     *           findOne with no match; count with a filter
     * Expected: update returns how many changed and bumps updated_at; id and space_id can't be changed
     *           (invalid_value); delete returns how many; findOne gives null; count counts
     */
    it('updates, deletes, counts and finds one', async () => {
      const { notes } = setup()
      const t = notes()
      await seedNotes(t)
      const before = (await t.findOne({ title: 'Gamma' }))!
      expect(await t.update({ priority: 2 }, { done: true })).toBe(2)
      const after = (await t.findOne({ title: 'Gamma' }))!
      expect(after.done).toBe(true)
      expect(after.created_at).toBe(before.created_at)
      expect(await code(t.update({}, { id: 'x' }))).toBe('invalid_value')
      expect(await code(t.update({}, { space_id: 'S2' }))).toBe('invalid_value')
      expect(await t.count({ done: true })).toBe(3)
      expect(await t.delete({ done: true })).toBe(3)
      expect(titles(await t.find())).toEqual(['Alpha plan'])
      expect(await t.findOne({ title: 'nope' })).toBeNull()
    })

    /**
     * Function: json columns and insertMany atomicity
     * Inputs:   a note with tags ["a","b"], read back; insertMany where the second row is invalid
     * Expected: the json round-trips exactly; the failed insertMany stores neither row
     */
    it('round-trips json and inserts many rows all-or-nothing', async () => {
      const { notes } = setup()
      const t = notes()
      const row = await t.insert({ title: 'tagged', tags: { list: ['a', 'b'], n: 1 } })
      expect((await t.findOne({ id: row.id as string }))!.tags).toEqual({ list: ['a', 'b'], n: 1 })
      expect(await code(t.insertMany([{ title: 'ok' }, { title: 5 as never }]))).toBe(
        'invalid_value',
      )
      expect(await t.count()).toBe(1)
    })

    /**
     * Function: global tables and unique indexes
     * Inputs:   a global "prefs" table used from two different Spaces; a duplicate key; an update that
     *           would create a duplicate
     * Expected: global rows are shared and have no space_id; a duplicate insert or update gives
     *           "duplicate" and changes nothing
     */
    it('supports global tables and enforces unique indexes', async () => {
      const { prefs } = setup()
      const row = await prefs().insert({ key: 'theme', value: 'dark' })
      expect(row).not.toHaveProperty('space_id')
      expect(await prefs().count()).toBe(1)
      expect(await code(prefs().insert({ key: 'theme', value: 'light' }))).toBe('duplicate')
      await prefs().insert({ key: 'lang', value: 'en' })
      expect(await code(prefs().update({ key: 'lang' }, { key: 'theme' }))).toBe('duplicate')
      expect((await prefs().findOne({ key: 'lang' }))!.value).toBe('en')
    })

    /**
     * Function: unique indexes on a Space table
     * Inputs:   the name "monthly" inserted in Space S1 and in S2; then again in S1; then a rename
     *           in S2 onto another of its own names; then a unique index added by a later migration
     *           with the same value in both Spaces
     * Expected: each Space may use the name once; repeats inside one Space give "duplicate"; one Space
     *           never learns about another's values; the later index is per Space too
     */
    it('keeps uniqueness inside each Space', async () => {
      const { store, schema } = setup()
      const tags = (space: string) => store.table(PAD, schema, 'tags', space)
      await tags('S1').insert({ name: 'monthly', extra: 'x' })
      await tags('S2').insert({ name: 'monthly', extra: 'x' })
      expect(await code(tags('S1').insert({ name: 'monthly' }))).toBe('duplicate')
      await tags('S2').insert({ name: 'yearly' })
      expect(await code(tags('S2').update({ name: 'yearly' }, { name: 'monthly' }))).toBe(
        'duplicate',
      )
      const later = collectOps(
        defineMigration('0002_unique_extra', (m) =>
          m.createIndex('tags', ['extra'], { unique: true }),
        ),
      )
      const next = applyOps(schema, later)
      store.applyOps(PAD, later)
      const t = (space: string) => store.table(PAD, next, 'tags', space)
      expect(await code(t('S1').insert({ name: 'other', extra: 'x' }))).toBe('duplicate')
      await t('S3').insert({ name: 'other', extra: 'x' })
    })

    /**
     * Function: store.table(padId, schema, name, spaceId)
     * Inputs:   a table that was never declared; and a Space table with no Space
     * Expected: PadDataError "unknown_table"; PadDataError "invalid_options"
     */
    it('refuses undeclared tables and Space tables without a Space', () => {
      const { store, schema } = setup()
      expect(() => store.table(PAD, schema, 'users', 'S1')).toThrow(PadDataError)
      expect(() => store.table(PAD, schema, 'notes', null)).toThrow(PadDataError)
    })

    /**
     * Function: store.applyOps (a later migration)
     * Inputs:   after rows exist, a migration adds a column "rank" with default 5 and a unique index
     * Expected: existing rows get the default; new inserts work with the new column
     */
    it('backfills a column added by a later migration', async () => {
      const { store, schema, notes } = setup()
      await notes().insertMany([{ title: 'a' }, { title: 'b' }])
      const ops = collectOps(
        defineMigration('0002_rank', (m) =>
          m.addColumn('notes', 'rank', { type: 'integer', default: 5 }),
        ),
      )
      const next = applyOps(schema, ops)
      store.applyOps(PAD, ops)
      const t = store.table(PAD, next, 'notes', 'S1')
      expect((await t.find()).map((r) => r.rank)).toEqual([5, 5])
      expect((await t.insert({ title: 'c', rank: 9 })).rank).toBe(9)
    })
  })
}
