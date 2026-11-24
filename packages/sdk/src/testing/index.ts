import { z, type ZodType } from 'zod'
import type {
  Role,
  PadContext,
  PadEvent,
  PadEventType,
  PadModule,
  PadScope,
  RouteHandler,
  RouteOptions,
  Schedule,
  ScopedCore,
  PadRouter,
} from '../context.js'
import { PadError } from '../context.js'
import {
  PadDataError,
  applyOps,
  collectOps,
  schemaFromMigrations,
  type PadSchema,
  type PadStore,
} from '../data.js'
import { createMemoryPadStore } from './memoryStore.js'

export { createMemoryPadStore }

/**
 * Test a pad without Pond: `createTestPad(module)` runs its migrations and `register` against an
 * in-memory store and lets you call its routes, send it events and run its jobs. Core data is
 * whatever you pass in `core` (empty by default).
 */
export interface TestPadOptions {
  spaceId?: string
  spaceType?: 'personal' | 'business'
  /** Pieces of core data the pad may read. Anything not given returns empty results. */
  core?: Partial<ScopedCore>
  now?: () => Date
}
export interface CallOptions {
  role?: Role
  params?: Record<string, string>
  query?: unknown
  body?: unknown
  spaceId?: string
}
export interface CallResult {
  status: number
  body: unknown
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 }

export async function createTestPad(module: PadModule, options: TestPadOptions = {}) {
  let n = 0
  const newId = () => `id-${++n}`
  // By default time moves forward one second per reading, so "newest first" has something to sort by.
  let tick = Date.parse('2030-01-15T12:00:00Z')
  const now = options.now ?? (() => new Date((tick += 1000)))
  const store: PadStore = createMemoryPadStore({ newId, now })
  const spaceId = options.spaceId ?? 'space-1'
  const spaceType = options.spaceType ?? module.manifest.spaceTypes[0]!

  let schema: PadSchema = {}
  for (const m of module.migrations) {
    const ops = collectOps(m)
    schema = applyOps(schema, ops)
    store.applyOps(module.manifest.id, ops)
  }
  schemaFromMigrations(module.migrations) // also checks for duplicate names

  const settings = new Map<string, string | number | boolean>()
  const audit: {
    action: string
    targetType?: string
    targetId?: string
    meta?: Record<string, unknown>
  }[] = []
  const logs: { level: string; message: string }[] = []
  const emptyCore: ScopedCore = {
    accounts: { list: async () => [] },
    categories: { list: async () => [] },
    transactions: { list: async () => ({ transactions: [], total: 0 }), get: async () => null },
    balances: { latest: async () => [], history: async () => [] },
    spaces: {
      get: async () => ({ id: spaceId, name: 'Test Space', type: spaceType, currency: 'USD' }),
    },
    splits: { sum: async () => [] },
    ...options.core,
  }

  const scopeFor = (role: Role | null, id: string): PadScope => ({
    padId: module.manifest.id,
    space: { id, type: spaceType, role },
    user: role ? { id: 'user-1', username: 'tester', displayName: 'Test User' } : null,
    core: emptyCore,
    db: {
      table: ((name: string) =>
        store.table(module.manifest.id, schema, name, id)) as PadScope['db']['table'],
    },
    settings: {
      get: async <T extends string | number | boolean>(key: string) => {
        const f = module.manifest.settings.find((s) => s.key === key)
        if (!f) throw new Error(`Unknown setting "${key}"`)
        return (settings.get(key) ?? f.default) as T
      },
      set: async (key, value) => void settings.set(key, value),
    },
    secrets: { encrypt: async (t) => `test:${t}`, decrypt: async (s) => s.replace(/^test:/, '') },
    audit: {
      record: async (e) =>
        void audit.push({ ...e, action: `lilypad.${module.manifest.id}.${e.action}` }),
    },
    log: Object.fromEntries(
      (['debug', 'info', 'warn', 'error'] as const).map((l) => [
        l,
        (message: string) => void logs.push({ level: l, message }),
      ]),
    ) as unknown as PadScope['log'],
    newId,
  })

  interface Route {
    method: string
    path: string
    opts: RouteOptions<unknown, unknown>
    handler: RouteHandler<unknown, unknown>
  }
  const routes: Route[] = []
  const eventHandlers: { type: PadEventType; handler: (e: PadEvent, s: PadScope) => unknown }[] = []
  const jobs = new Map<string, { schedule: Schedule; handler: (s: PadScope) => unknown }>()
  const add =
    (method: string) =>
    (path: string, opts: RouteOptions<unknown, unknown>, handler: RouteHandler<unknown, unknown>) =>
      void routes.push({ method, path, opts, handler })
  const router = {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
  } as unknown as PadRouter
  const ctx: PadContext = {
    manifest: module.manifest,
    router,
    events: { on: (type, handler) => void eventHandlers.push({ type, handler: handler as never }) },
    jobs: { schedule: (name, schedule, handler) => void jobs.set(name, { schedule, handler }) },
    log: scopeFor(null, spaceId).log,
  }
  await module.server.register(ctx)

  const matchPath = (pattern: string, actual: string): Record<string, string> | null => {
    const a = pattern.split('/')
    const b = actual.split('/')
    if (a.length !== b.length) return null
    const params: Record<string, string> = {}
    for (let i = 0; i < a.length; i++) {
      if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!)
      else if (a[i] !== b[i]) return null
    }
    return params
  }
  const parse = <T>(schema: ZodType<T> | undefined, value: unknown) =>
    schema ? schema.safeParse(value) : { success: true as const, data: value as T }

  return {
    /** Calls a route the way Pond would: role check, validation, then the handler. */
    async call(method: string, path: string, o: CallOptions = {}): Promise<CallResult> {
      const role = o.role ?? 'owner'
      for (const r of routes) {
        const params = r.method === method ? matchPath(r.path, path) : null
        if (!params) continue
        if (RANK[role] < RANK[r.opts.role]) return { status: 403, body: { error: 'forbidden' } }
        const body = parse(r.opts.body, o.body)
        const query = parse(r.opts.query, o.query ?? {})
        if (!body.success || !query.success)
          return { status: 400, body: { error: 'invalid_input' } }
        try {
          const scope = scopeFor(role, o.spaceId ?? spaceId)
          const out = await r.handler({
            ...scope,
            params: { ...params, ...o.params },
            query: query.data,
            body: body.data,
          })
          return { status: 200, body: out === undefined ? {} : JSON.parse(JSON.stringify(out)) }
        } catch (e) {
          if (e instanceof PadError) return { status: e.status, body: { error: e.code } }
          if (e instanceof PadDataError) return { status: 400, body: { error: e.code } }
          throw e
        }
      }
      return { status: 404, body: { error: 'not_found' } }
    },
    async emit(event: PadEvent) {
      for (const h of eventHandlers.filter((x) => x.type === event.type))
        await h.handler(event, scopeFor(null, event.spaceId))
    },
    async runJob(name: string) {
      const j = jobs.get(name)
      if (!j) throw new Error(`No job "${name}"`)
      await j.handler(scopeFor(null, spaceId))
    },
    jobs: () => [...jobs.entries()].map(([name, j]) => ({ name, schedule: j.schedule })),
    routes: () => routes.map((r) => ({ method: r.method, path: r.path, role: r.opts.role })),
    /** Direct access to the pad's tables, for assertions. */
    table: (name: string, forSpace = spaceId) =>
      store.table(module.manifest.id, schema, name, forSpace),
    audit,
    logs,
    settings,
  }
}

export { z }
