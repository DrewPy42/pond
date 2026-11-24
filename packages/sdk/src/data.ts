/**
 * A pad's own data: declarative migrations, and the table API.
 * (docs/lilypad-host-design.md, "Pad data: table API and migrations".)
 *
 * There is no SQL here on purpose. Everything is plain, JSON-serializable data, so the same pad
 * code runs against SQLite, an in-memory fake, or (later) a remote host.
 */

export type Scalar = string | number | boolean | null
export type JsonValue = Scalar | JsonValue[] | { [key: string]: JsonValue }

// ---------- Schema ----------

export const COLUMN_TYPES = ['text', 'integer', 'boolean', 'json'] as const
export type ColumnType = (typeof COLUMN_TYPES)[number]

export interface ColumnDef {
  /** `integer` is for whole numbers such as cents. There are no floats. */
  type: ColumnType
  nullable?: boolean
  default?: JsonValue
}
export type TableScope = 'space' | 'global'
export interface IndexDef {
  columns: string[]
  unique: boolean
}

export interface TableSchema {
  /** `space` tables get a `space_id` column and are automatically limited to the current Space. */
  scope: TableScope
  /** Declared columns only; `id`, `space_id`, `created_at` and `updated_at` are added by the host. */
  columns: Record<string, ColumnDef>
  indexes: IndexDef[]
}
export type PadSchema = Record<string, TableSchema>

export type SchemaOp =
  | {
      op: 'createTable'
      table: string
      scope: TableScope
      columns: Record<string, ColumnDef>
      indexes: IndexDef[]
    }
  | { op: 'addColumn'; table: string; column: string; def: ColumnDef }
  | { op: 'createIndex'; table: string; columns: string[]; unique: boolean }

export class PadSchemaError extends Error {}

const IDENT = /^[a-z][a-z0-9_]{0,39}$/
export const RESERVED_COLUMNS = ['id', 'space_id', 'created_at', 'updated_at'] as const
export const isIdentifier = (s: string): boolean => IDENT.test(s)

export interface MigrationBuilder {
  createTable(
    table: string,
    def: {
      scope?: TableScope
      columns: Record<string, ColumnDef | ColumnType>
      indexes?: { columns: string[]; unique?: boolean }[]
    },
  ): void
  addColumn(table: string, column: string, def: ColumnDef | ColumnType): void
  createIndex(table: string, columns: string[], opts?: { unique?: boolean }): void
}
export interface Migration {
  /** Unique within the pad, applied in list order, never edited once released. */
  name: string
  up(m: MigrationBuilder): void
}
export const defineMigration = (name: string, up: Migration['up']): Migration => ({ name, up })

const col = (d: ColumnDef | ColumnType): ColumnDef => (typeof d === 'string' ? { type: d } : d)

/** Runs a migration function and returns the operations it describes. */
export function collectOps(migration: Migration): SchemaOp[] {
  const ops: SchemaOp[] = []
  migration.up({
    createTable: (table, def) =>
      ops.push({
        op: 'createTable',
        table,
        scope: def.scope ?? 'space',
        columns: Object.fromEntries(Object.entries(def.columns).map(([k, v]) => [k, col(v)])),
        indexes: (def.indexes ?? []).map((i) => ({
          columns: i.columns,
          unique: i.unique ?? false,
        })),
      }),
    addColumn: (table, column, def) => ops.push({ op: 'addColumn', table, column, def: col(def) }),
    createIndex: (table, columns, opts) =>
      ops.push({ op: 'createIndex', table, columns, unique: opts?.unique ?? false }),
  })
  return ops
}

function checkColumn(name: string, def: ColumnDef): void {
  if (!isIdentifier(name)) throw new PadSchemaError(`Bad column name "${name}"`)
  if ((RESERVED_COLUMNS as readonly string[]).includes(name))
    throw new PadSchemaError(`"${name}" is reserved`)
  if (!COLUMN_TYPES.includes(def.type)) throw new PadSchemaError(`Bad type for "${name}"`)
  if (def.default !== undefined && !valueFits(def, def.default))
    throw new PadSchemaError(`Default for "${name}" has the wrong type`)
}

/** Applies operations to a schema, validating as it goes. Pure: returns a new schema. */
export function applyOps(schema: PadSchema, ops: SchemaOp[]): PadSchema {
  const next: PadSchema = structuredClone(schema)
  for (const op of ops) {
    if (!isIdentifier(op.table)) throw new PadSchemaError(`Bad table name "${op.table}"`)
    if (op.op === 'createTable') {
      if (next[op.table]) throw new PadSchemaError(`Table "${op.table}" already exists`)
      for (const [name, def] of Object.entries(op.columns)) checkColumn(name, def)
      const t: TableSchema = { scope: op.scope, columns: op.columns, indexes: [] }
      next[op.table] = t
      for (const i of op.indexes) addIndex(t, op.table, i.columns, i.unique)
    } else if (op.op === 'addColumn') {
      const t = next[op.table]
      if (!t) throw new PadSchemaError(`Unknown table "${op.table}"`)
      if (t.columns[op.column]) throw new PadSchemaError(`Column "${op.column}" already exists`)
      checkColumn(op.column, op.def)
      if (!op.def.nullable && op.def.default === undefined) {
        throw new PadSchemaError(`New column "${op.column}" must be nullable or have a default`)
      }
      t.columns[op.column] = op.def
    } else {
      const t = next[op.table]
      if (!t) throw new PadSchemaError(`Unknown table "${op.table}"`)
      addIndex(t, op.table, op.columns, op.unique)
    }
  }
  return next
}

function addIndex(t: TableSchema, table: string, columns: string[], unique: boolean) {
  if (columns.length === 0 || columns.length > 4)
    throw new PadSchemaError('An index needs 1 to 4 columns')
  for (const c of columns) {
    const known =
      c === 'space_id'
        ? t.scope === 'space'
        : c in t.columns || c === 'created_at' || c === 'updated_at'
    if (!known) throw new PadSchemaError(`Index on unknown column "${c}" of "${table}"`)
  }
  t.indexes.push({ columns, unique })
}

/** The schema a pad ends up with after all its migrations. */
export function schemaFromMigrations(migrations: readonly Migration[]): PadSchema {
  const names = new Set<string>()
  let schema: PadSchema = {}
  for (const m of migrations) {
    if (names.has(m.name)) throw new PadSchemaError(`Duplicate migration name "${m.name}"`)
    names.add(m.name)
    schema = applyOps(schema, collectOps(m))
  }
  return schema
}

// ---------- Values ----------

/** Does `value` suit this column? (null is allowed only for nullable columns.) */
export function valueFits(def: ColumnDef, value: unknown): boolean {
  if (value === null) return def.nullable === true
  switch (def.type) {
    case 'text':
      return typeof value === 'string' && value.length <= 100_000
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'json':
      try {
        return JSON.stringify(value).length <= 100_000
      } catch {
        return false
      }
  }
}

// ---------- Table API ----------

export type Condition =
  | Scalar
  | {
      ne?: Scalar
      gt?: Scalar
      gte?: Scalar
      lt?: Scalar
      lte?: Scalar
      in?: Scalar[]
      isNull?: boolean
      /** Case-insensitive substring match (text columns). */
      contains?: string
      /** Case-insensitive prefix match (text columns). */
      startsWith?: string
    }
/** AND of column conditions, plus an optional `$or` list: at least one of those must also match. */
export interface Where {
  [column: string]: Condition | Where[] | undefined
  $or?: Where[]
}
export interface FindOptions {
  where?: Where
  orderBy?: [column: string, direction: 'asc' | 'desc'][]
  limit?: number
  offset?: number
}
export type Row = Record<string, JsonValue>

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 1000

export interface TableApi<R extends Row = Row> {
  find(opts?: FindOptions): Promise<R[]>
  findOne(where: Where): Promise<R | null>
  /** Adds `id` (a UUIDv7), `space_id` (current Space), `created_at` and `updated_at` automatically. */
  insert(row: Record<string, JsonValue>): Promise<R>
  insertMany(rows: Record<string, JsonValue>[]): Promise<R[]>
  /** Returns how many rows changed. Cannot change `id` or `space_id`. */
  update(where: Where, patch: Record<string, JsonValue>): Promise<number>
  delete(where: Where): Promise<number>
  count(where?: Where): Promise<number>
}

export class PadDataError extends Error {
  constructor(
    public code:
      | 'unknown_table'
      | 'unknown_column'
      | 'invalid_value'
      | 'invalid_where'
      | 'invalid_options'
      | 'not_nullable'
      | 'duplicate',
    message: string,
  ) {
    super(message)
  }
}

/** Where a table lives: used by stores to name the physical table `lp_<padId>_<table>`. */
export const physicalTableName = (padId: string, table: string): string =>
  `lp_${padId.replace(/-/g, '_')}_${table}`

/** Everything a store needs: DDL, drop, and a table API bound to one Space. */
export interface PadStore {
  /** Creates or alters tables. Called once per migration, inside the host's transaction. */
  applyOps(padId: string, ops: SchemaOp[]): void
  /** Drops all of a pad's tables (uninstall with "delete data"). */
  dropPad(padId: string, schema: PadSchema): void
  /** A table API for one table. `spaceId` is required for `space` tables and ignored for `global`. */
  table(padId: string, schema: PadSchema, table: string, spaceId: string | null): TableApi
}

// ---------- Normalized where ----------

export type Pred =
  | { col: string; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; value: Scalar }
  | { col: string; op: 'in'; value: Scalar[] }
  | { col: string; op: 'isNull' | 'notNull' }
  | { col: string; op: 'contains' | 'startsWith'; value: string }
export interface WhereNode {
  preds: Pred[]
  /** At least one of these must also hold. */
  or: WhereNode[] | null
}

const OPS = ['ne', 'gt', 'gte', 'lt', 'lte', 'in', 'isNull', 'contains', 'startsWith'] as const

/** Columns a where clause may name: declared ones plus the automatic ones. */
export function filterableColumns(t: TableSchema): Record<string, ColumnDef> {
  return {
    ...t.columns,
    id: { type: 'text' },
    created_at: { type: 'text' },
    updated_at: { type: 'text' },
    ...(t.scope === 'space' ? { space_id: { type: 'text' } } : {}),
  }
}

/**
 * Checks a where clause against the table and turns it into a predicate tree both the SQLite
 * store and the memory store evaluate. Unknown columns, bad operators and wrongly-typed values
 * are refused here, so nothing the pad sends reaches a query unchecked.
 */
export function normalizeWhere(t: TableSchema, where: Where | undefined, depth = 0): WhereNode {
  const node: WhereNode = { preds: [], or: null }
  if (!where) return node
  if (depth > 3) throw new PadDataError('invalid_where', 'Too many nested $or groups')
  const cols = filterableColumns(t)
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue
    if (key === '$or') {
      if (!Array.isArray(cond) || cond.length === 0 || cond.length > 10)
        throw new PadDataError('invalid_where', '$or needs 1 to 10 conditions')
      node.or = cond.map((w) => normalizeWhere(t, w, depth + 1))
      continue
    }
    const def = cols[key]
    if (!def) throw new PadDataError('unknown_column', `Unknown column "${key}"`)
    if (def.type === 'json')
      throw new PadDataError('invalid_where', `Can't filter on json column "${key}"`)
    const check = (v: unknown): Scalar => {
      if (v === null) return null
      if (!valueFits({ ...def, nullable: true }, v))
        throw new PadDataError('invalid_value', `Bad value for "${key}"`)
      return v as Scalar
    }
    if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) {
      const v = check(cond as Scalar)
      node.preds.push(v === null ? { col: key, op: 'isNull' } : { col: key, op: 'eq', value: v })
      continue
    }
    for (const [op, v] of Object.entries(cond)) {
      if (!(OPS as readonly string[]).includes(op))
        throw new PadDataError('invalid_where', `Unknown operator "${op}"`)
      if (v === undefined) continue
      switch (op) {
        case 'isNull':
          node.preds.push({ col: key, op: v ? 'isNull' : 'notNull' })
          break
        case 'in': {
          if (!Array.isArray(v) || v.length > 500)
            throw new PadDataError('invalid_where', '"in" needs a list of up to 500 values')
          node.preds.push({ col: key, op: 'in', value: v.map(check) })
          break
        }
        case 'contains':
        case 'startsWith':
          if (def.type !== 'text' || typeof v !== 'string')
            throw new PadDataError('invalid_where', `"${op}" works on text columns with text`)
          node.preds.push({ col: key, op, value: v })
          break
        default: {
          const sv = check(v as Scalar)
          if (sv === null) throw new PadDataError('invalid_value', `"${op}" needs a value`)
          if (def.type === 'boolean' && op !== 'ne')
            throw new PadDataError('invalid_where', `"${op}" doesn't apply to booleans`)
          node.preds.push({ col: key, op: op as 'ne' | 'gt' | 'gte' | 'lt' | 'lte', value: sv })
        }
      }
    }
  }
  return node
}

export function normalizeOptions(t: TableSchema, o: FindOptions | undefined) {
  const cols = filterableColumns(t)
  const orderBy = (o?.orderBy ?? []).map(([c, d]) => {
    if (!cols[c] || cols[c]!.type === 'json')
      throw new PadDataError('unknown_column', `Can't order by "${c}"`)
    if (d !== 'asc' && d !== 'desc')
      throw new PadDataError('invalid_options', 'Direction must be asc or desc')
    return [c, d] as [string, 'asc' | 'desc']
  })
  const limit = o?.limit ?? DEFAULT_LIMIT
  const offset = o?.offset ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new PadDataError('invalid_options', `limit must be 1 to ${MAX_LIMIT}`)
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000_000)
    throw new PadDataError('invalid_options', 'Bad offset')
  return { where: normalizeWhere(t, o?.where), orderBy, limit, offset }
}

/** Validates a row for insert (`strict`) or a patch for update. Returns only declared columns. */
export function checkRow(
  t: TableSchema,
  row: Record<string, unknown>,
  mode: 'insert' | 'patch',
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(row)) {
    if (RESERVED_COLUMNS.includes(k as (typeof RESERVED_COLUMNS)[number])) {
      throw new PadDataError('invalid_value', `"${k}" is set by Pond and can't be written`)
    }
    const def = t.columns[k]
    if (!def) throw new PadDataError('unknown_column', `Unknown column "${k}"`)
    if (v === undefined) continue
    if (v === null && !def.nullable) throw new PadDataError('not_nullable', `"${k}" can't be empty`)
    if (!valueFits(def, v)) throw new PadDataError('invalid_value', `Bad value for "${k}"`)
    out[k] = v as JsonValue
  }
  if (mode === 'insert') {
    for (const [name, def] of Object.entries(t.columns)) {
      if (name in out) continue
      if (def.default !== undefined) out[name] = def.default
      else if (def.nullable) out[name] = null
      else throw new PadDataError('not_nullable', `"${name}" is required`)
    }
  }
  return out
}
