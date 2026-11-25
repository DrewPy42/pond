import {
  PadDataError,
  checkRow,
  isIdentifier,
  normalizeOptions,
  normalizeWhere,
  physicalTableName,
  type ColumnDef,
  type JsonValue,
  type PadSchema,
  type PadStore,
  type Row,
  type SchemaOp,
  type TableApi,
  type TableSchema,
  type WhereNode,
} from '@pond/sdk'
import type Database from 'better-sqlite3'

/**
 * The SQLite PadStore: runs the DDL for pad migrations and implements the table API.
 *
 * Nothing a pad sends becomes SQL text. Table and column names are checked against the pad's own
 * declared schema (identifiers only), and every value is a bound parameter. The same contract
 * suite as the in-memory store (packages/sdk/src/testing/storeContract.ts) runs against this one.
 */
export function createSqlitePadStore(
  sqlite: Database.Database,
  opts: { newId: () => string; now: () => Date },
): PadStore {
  const q = (ident: string): string => {
    if (!/^[a-z][a-z0-9_]*$/.test(ident)) throw new Error(`Unsafe identifier "${ident}"`)
    return `"${ident}"`
  }
  const physical = (padId: string, table: string): string => {
    const name = physicalTableName(padId, table)
    if (!/^lp_[a-z0-9_]+$/.test(name) || !isIdentifier(table))
      throw new Error(`Unsafe table name "${name}"`)
    return `"${name}"`
  }
  const sqlType = (d: ColumnDef) => (d.type === 'text' || d.type === 'json' ? 'TEXT' : 'INTEGER')
  const literal = (d: ColumnDef, v: JsonValue): string => {
    if (v === null) return 'NULL'
    if (d.type === 'integer') return String(Number(v))
    if (d.type === 'boolean') return v ? '1' : '0'
    return `'${(d.type === 'json' ? JSON.stringify(v) : String(v)).replace(/'/g, "''")}'`
  }
  const encode = (d: ColumnDef, v: JsonValue | undefined): string | number | null => {
    if (v === null || v === undefined) return null
    if (d.type === 'json') return JSON.stringify(v)
    if (d.type === 'boolean') return v ? 1 : 0
    return v as string | number
  }
  const decode = (t: TableSchema, raw: Record<string, unknown>): Row => {
    const out: Row = { id: raw.id as string }
    if (t.scope === 'space') out.space_id = raw.space_id as string
    for (const [name, d] of Object.entries(t.columns)) {
      const v = raw[name]
      out[name] = (
        v === null || v === undefined
          ? null
          : d.type === 'json'
            ? JSON.parse(v as string)
            : d.type === 'boolean'
              ? v === 1
              : v
      ) as JsonValue
    }
    out.created_at = raw.created_at as string
    out.updated_at = raw.updated_at as string
    return out
  }
  const isUnique = (e: unknown) => String((e as Error)?.message).includes('UNIQUE constraint')

  /** On a Space table, "unique" means unique within one Space, so the Space is part of the index. */
  const indexColumns = (cols: string[], unique: boolean, perSpace: boolean): string =>
    [...(unique && perSpace ? ['space_id'] : []), ...cols].map(q).join(', ')
  const hasSpaceColumn = (padId: string, table: string): boolean =>
    !!sqlite
      .prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'space_id'")
      .get(physicalTableName(padId, table))

  const ddl = (padId: string, op: SchemaOp): string[] => {
    const table = physical(padId, op.table)
    const indexName = (cols: string[], unique: boolean) =>
      `"${physicalTableName(padId, op.table)}__${cols.join('_')}${unique ? '_u' : ''}"`
    if (op.op === 'createTable') {
      const cols = [
        '"id" TEXT PRIMARY KEY NOT NULL',
        ...(op.scope === 'space' ? ['"space_id" TEXT NOT NULL'] : []),
        ...Object.entries(op.columns).map(
          ([n, d]) => `${q(n)} ${sqlType(d)}${d.nullable ? '' : ' NOT NULL'}`,
        ),
        '"created_at" TEXT NOT NULL',
        '"updated_at" TEXT NOT NULL',
      ]
      const stmts = [`CREATE TABLE ${table} (${cols.join(', ')})`]
      if (op.scope === 'space')
        stmts.push(`CREATE INDEX ${indexName(['space_id'], false)} ON ${table} ("space_id")`)
      for (const i of op.indexes)
        stmts.push(
          `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${indexName(i.columns, i.unique)} ON ${table} (${indexColumns(i.columns, i.unique, op.scope === 'space')})`,
        )
      return stmts
    }
    if (op.op === 'addColumn') {
      const d = op.def
      const dflt = d.default !== undefined ? ` DEFAULT ${literal(d, d.default)}` : ''
      return [
        `ALTER TABLE ${table} ADD COLUMN ${q(op.column)} ${sqlType(d)}${d.nullable ? '' : ' NOT NULL'}${dflt}`,
      ]
    }
    return [
      `CREATE ${op.unique ? 'UNIQUE ' : ''}INDEX ${indexName(op.columns, op.unique)} ON ${table} (${indexColumns(op.columns, op.unique, hasSpaceColumn(padId, op.table))})`,
    ]
  }

  // ----- where compilation: names come from the checked schema, values are bound parameters -----
  const compile = (t: TableSchema, node: WhereNode, params: (string | number | null)[]): string => {
    const parts: string[] = []
    const colDef = (c: string): ColumnDef | undefined => t.columns[c]
    const bind = (c: string, v: unknown): string | number | null => {
      const d = colDef(c)
      if (v === null) return null
      if (d?.type === 'boolean') return v ? 1 : 0
      return v as string | number
    }
    const like = (v: string, mode: 'contains' | 'startsWith') => {
      const esc = v.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)
      return mode === 'contains' ? `%${esc}%` : `${esc}%`
    }
    for (const p of node.preds) {
      const c = q(p.col)
      switch (p.op) {
        case 'isNull':
          parts.push(`${c} IS NULL`)
          break
        case 'notNull':
          parts.push(`${c} IS NOT NULL`)
          break
        case 'in':
          if (p.value.length === 0) parts.push('0')
          else {
            parts.push(`${c} IN (${p.value.map(() => '?').join(', ')})`)
            params.push(...p.value.map((v) => bind(p.col, v)))
          }
          break
        case 'contains':
        case 'startsWith':
          parts.push(`lower(${c}) LIKE ? ESCAPE '\\'`)
          params.push(like(p.value, p.op))
          break
        default: {
          const op = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[p.op]
          parts.push(`${c} ${op} ?`)
          params.push(bind(p.col, p.value))
        }
      }
    }
    if (node.or) {
      parts.push(`(${node.or.map((n) => `(${compile(t, n, params) || '1'})`).join(' OR ')})`)
    }
    return parts.join(' AND ')
  }

  return {
    applyOps(padId, ops) {
      for (const op of ops) for (const stmt of ddl(padId, op)) sqlite.exec(stmt)
    },
    dropPad(padId, schema: PadSchema) {
      for (const t of Object.keys(schema)) sqlite.exec(`DROP TABLE IF EXISTS ${physical(padId, t)}`)
    },
    table(padId, schema, table, spaceId): TableApi {
      const t = schema[table]
      if (!t) throw new PadDataError('unknown_table', `Unknown table "${table}"`)
      if (t.scope === 'space' && !spaceId)
        throw new PadDataError('invalid_options', 'This table needs a Space')
      const name = physical(padId, table)
      const scope = (params: (string | number | null)[]): string[] => {
        if (t.scope !== 'space') return []
        params.push(spaceId!)
        return ['"space_id" = ?']
      }
      const where = (n: WhereNode, params: (string | number | null)[]): string => {
        const clauses = [...scope(params), compile(t, n, params)].filter(Boolean)
        return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      }
      const buildRow = (input: Record<string, JsonValue>) => {
        const data = checkRow(t, input, 'insert')
        const now = opts.now().toISOString()
        return { id: opts.newId(), data, now }
      }
      const insertOne = (r: { id: string; data: Record<string, JsonValue>; now: string }) => {
        const cols = [
          'id',
          ...(t.scope === 'space' ? ['space_id'] : []),
          ...Object.keys(t.columns),
          'created_at',
          'updated_at',
        ]
        const vals = [
          r.id,
          ...(t.scope === 'space' ? [spaceId!] : []),
          ...Object.entries(t.columns).map(([n, d]) => encode(d, r.data[n])),
          r.now,
          r.now,
        ]
        try {
          sqlite
            .prepare(
              `INSERT INTO ${name} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            )
            .run(...vals)
        } catch (e) {
          if (isUnique(e))
            throw new PadDataError('duplicate', 'That would duplicate an existing row')
          throw e
        }
        return decode(t, {
          id: r.id,
          space_id: spaceId,
          ...Object.fromEntries(
            Object.entries(t.columns).map(([n, d]) => [n, encode(d, r.data[n])]),
          ),
          created_at: r.now,
          updated_at: r.now,
        })
      }
      return {
        async find(o) {
          const n = normalizeOptions(t, o)
          const params: (string | number | null)[] = []
          const w = where(n.where, params)
          const order = [
            ...n.orderBy.map(([c, d]) => `${q(c)} ${d === 'asc' ? 'ASC' : 'DESC'}`),
            'rowid ASC',
          ].join(', ')
          const rows = sqlite
            .prepare(`SELECT * FROM ${name} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
            .all(...params, n.limit, n.offset) as Record<string, unknown>[]
          return rows.map((r) => decode(t, r))
        },
        async findOne(w) {
          const rows = await this.find({ where: w, limit: 1 })
          return rows[0] ?? null
        },
        async insert(row) {
          return insertOne(buildRow(row))
        },
        async insertMany(rows) {
          const built = rows.map(buildRow)
          return sqlite.transaction(() => built.map(insertOne))()
        },
        async update(w, patch) {
          const data = checkRow(t, patch, 'patch')
          const n = normalizeWhere(t, w)
          const sets = Object.keys(data)
          const params: (string | number | null)[] = [
            ...sets.map((c) => encode(t.columns[c]!, data[c])),
            opts.now().toISOString(),
          ]
          const clause = where(n, params)
          try {
            return sqlite
              .prepare(
                `UPDATE ${name} SET ${[...sets.map((c) => `${q(c)} = ?`), '"updated_at" = ?'].join(', ')} ${clause}`,
              )
              .run(...params).changes
          } catch (e) {
            if (isUnique(e))
              throw new PadDataError('duplicate', 'That would duplicate an existing row')
            throw e
          }
        },
        async delete(w) {
          const params: (string | number | null)[] = []
          const clause = where(normalizeWhere(t, w), params)
          return sqlite.prepare(`DELETE FROM ${name} ${clause}`).run(...params).changes
        },
        async count(w) {
          const params: (string | number | null)[] = []
          const clause = where(normalizeWhere(t, w), params)
          return (
            sqlite.prepare(`SELECT count(*) AS n FROM ${name} ${clause}`).get(...params) as {
              n: number
            }
          ).n
        },
      }
    },
  }
}
