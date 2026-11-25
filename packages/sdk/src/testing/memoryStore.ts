import {
  PadDataError,
  checkRow,
  normalizeOptions,
  normalizeWhere,
  physicalTableName,
  type JsonValue,
  type PadSchema,
  type PadStore,
  type Pred,
  type Row,
  type SchemaOp,
  type TableApi,
  type TableSchema,
  type WhereNode,
} from '../data.js'

/**
 * An in-memory PadStore with exactly the behavior the SQLite store has (the server runs one
 * contract suite against both). Pad authors use it, through `createTestPad`, to test a pad
 * without Pond's core or a database.
 */
export function createMemoryPadStore(opts: { newId: () => string; now: () => Date }): PadStore {
  interface Table {
    rows: Row[]
    unique: string[][]
  }
  const tables = new Map<string, Table>()
  const iso = () => opts.now().toISOString()

  const evalPred = (row: Row, p: Pred): boolean => {
    const v = row[p.col] ?? null
    switch (p.op) {
      case 'isNull':
        return v === null
      case 'notNull':
        return v !== null
      case 'eq':
        return v !== null && v === p.value
      case 'ne':
        return v !== null && v !== p.value
      case 'in':
        return v !== null && p.value.includes(v as string | number | boolean | null)
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        if (v === null || typeof v !== typeof p.value) return false
        const a = v as string | number
        const b = p.value as string | number
        return p.op === 'gt' ? a > b : p.op === 'gte' ? a >= b : p.op === 'lt' ? a < b : a <= b
      }
      case 'contains':
        return typeof v === 'string' && v.toLowerCase().includes(p.value.toLowerCase())
      case 'startsWith':
        return typeof v === 'string' && v.toLowerCase().startsWith(p.value.toLowerCase())
    }
  }
  const matches = (row: Row, n: WhereNode): boolean =>
    n.preds.every((p) => evalPred(row, p)) && (n.or === null || n.or.some((o) => matches(row, o)))

  const cmp = (a: JsonValue | undefined, b: JsonValue | undefined): number => {
    const x = a ?? null
    const y = b ?? null
    if (x === y) return 0
    if (x === null) return -1 // like SQLite: NULLs sort first ascending
    if (y === null) return 1
    return x < y ? -1 : 1
  }

  return {
    applyOps(padId, ops: SchemaOp[]) {
      for (const op of ops) {
        const name = physicalTableName(padId, op.table)
        if (op.op === 'createTable') {
          tables.set(name, {
            rows: [],
            unique: op.indexes.filter((i) => i.unique).map((i) => i.columns),
          })
        } else if (op.op === 'addColumn') {
          for (const r of tables.get(name)!.rows)
            r[op.column] = (op.def.default ?? null) as JsonValue
        } else if (op.unique) {
          tables.get(name)!.unique.push(op.columns)
        }
      }
    },
    dropPad(padId, schema: PadSchema) {
      for (const t of Object.keys(schema)) tables.delete(physicalTableName(padId, t))
    },
    table(padId, schema, table, spaceId): TableApi {
      const t: TableSchema | undefined = schema[table]
      if (!t) throw new PadDataError('unknown_table', `Unknown table "${table}"`)
      if (t.scope === 'space' && !spaceId)
        throw new PadDataError('invalid_options', 'This table needs a Space')
      const store = tables.get(physicalTableName(padId, table))!
      const scoped = () => store.rows.filter((r) => t.scope !== 'space' || r.space_id === spaceId)
      const clash = (candidate: Row, ignore?: Row) =>
        store.unique.some((cols) =>
          store.rows.some(
            (r) =>
              r !== ignore &&
              // On a Space table, "unique" means unique within one Space.
              (t.scope !== 'space' || r.space_id === candidate.space_id) &&
              cols.every(
                (c) => (r[c] ?? null) === (candidate[c] ?? null) && (candidate[c] ?? null) !== null,
              ),
          ),
        )

      const build = (input: Record<string, JsonValue>): Row => {
        const data = checkRow(t, input, 'insert')
        const now = iso()
        return {
          id: opts.newId(),
          ...(t.scope === 'space' ? { space_id: spaceId! } : {}),
          ...data,
          created_at: now,
          updated_at: now,
        }
      }
      return {
        async find(o) {
          const n = normalizeOptions(t, o)
          const hit = scoped().filter((r) => matches(r, n.where))
          if (n.orderBy.length) {
            hit.sort((a, b) => {
              for (const [c, d] of n.orderBy) {
                const r = cmp(a[c], b[c])
                if (r !== 0) return d === 'asc' ? r : -r
              }
              return 0
            })
          }
          return structuredClone(hit.slice(n.offset, n.offset + n.limit))
        },
        async findOne(where) {
          const rows = await this.find({ where, limit: 1 })
          return rows[0] ?? null
        },
        async insert(row) {
          const r = build(row)
          if (clash(r)) throw new PadDataError('duplicate', 'That would duplicate an existing row')
          store.rows.push(r)
          return structuredClone(r)
        },
        async insertMany(rows) {
          const built = rows.map(build)
          const added: Row[] = []
          for (const r of built) {
            if (clash(r)) {
              for (const a of added) store.rows.splice(store.rows.indexOf(a), 1)
              throw new PadDataError('duplicate', 'That would duplicate an existing row')
            }
            store.rows.push(r)
            added.push(r)
          }
          return structuredClone(built)
        },
        async update(where, patch) {
          const data = checkRow(t, patch, 'patch')
          const hit = scoped().filter((r) => matches(r, normalizeWhere(t, where)))
          const next = hit.map((r) => ({ ...r, ...data, updated_at: iso() }))
          next.forEach((n, i) => {
            if (clash(n, hit[i]))
              throw new PadDataError('duplicate', 'That would duplicate an existing row')
          })
          hit.forEach((r, i) => Object.assign(r, next[i]))
          return hit.length
        },
        async delete(where) {
          const hit = new Set(scoped().filter((r) => matches(r, normalizeWhere(t, where))))
          store.rows = store.rows.filter((r) => !hit.has(r))
          return hit.size
        },
        async count(where) {
          const n = normalizeWhere(t, where)
          return scoped().filter((r) => matches(r, n)).length
        },
      }
    },
  }
}
