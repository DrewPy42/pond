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
import { checkUploadSpec, detectFileType, isPadDownload, safeDownloadName } from '../files.js'
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
  /** The bytes to send to an upload route. */
  file?: Uint8Array
  /** For `reauth` routes: whether the password was entered recently. Defaults to true. */
  reauthed?: boolean
}
export interface CallResult {
  status: number
  body: unknown
  /** Set when the route returned a file. */
  download?: { filename: string; bytes: Uint8Array }
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
  // Pad files, in memory, kept apart per Space like on a real Pond.
  const files = new Map<string, Uint8Array>()
  const needFiles = () => {
    if (!module.manifest.permissions.includes('files:store'))
      throw new Error('This pad did not ask for the "files:store" permission')
  }
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
    files: {
      download: async (fileId, filename) => {
        needFiles()
        if (!files.has(`${id}/${fileId}`)) throw new PadError(404, 'not_found')
        return { $padDownload: { fileId, filename } }
      },
      remove: async (fileId) => {
        needFiles()
        files.delete(`${id}/${fileId}`)
      },
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
    (
      path: string,
      opts: RouteOptions<unknown, unknown>,
      handler: RouteHandler<unknown, unknown>,
    ) => {
      if (opts.upload) {
        needFiles()
        checkUploadSpec(opts.upload)
        if (method !== 'POST' && method !== 'PUT') throw new Error('upload routes are POST or PUT')
        if (opts.body) throw new Error("an upload route takes a file, so it can't declare a body")
      }
      routes.push({ method, path, opts, handler })
    }
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
        if (r.opts.reauth && o.reauthed === false)
          return { status: 403, body: { error: 'reauth_required' } }
        const upload = r.opts.upload
        const sentType = upload && o.file ? detectFileType(o.file) : null
        if (upload) {
          if (o.file && o.file.length > upload.maxBytes)
            return { status: 413, body: { error: 'file_too_large' } }
          if (!o.file?.length) return { status: 400, body: { error: 'file_required' } }
          if (!sentType || !upload.types.includes(sentType))
            return { status: 415, body: { error: 'unsupported_file_type' } }
        }
        const body = parse(r.opts.body, o.body)
        const query = parse(r.opts.query, o.query ?? {})
        if (!body.success || !query.success)
          return { status: 400, body: { error: 'invalid_input' } }
        const inSpace = o.spaceId ?? spaceId
        const stored = upload ? newId() : null
        if (stored) files.set(`${inSpace}/${stored}`, o.file!.slice())
        try {
          const scope = scopeFor(role, inSpace)
          const out = await r.handler({
            ...(stored ? { file: { id: stored, size: o.file!.length, type: sentType! } } : {}),
            ...scope,
            params: { ...params, ...o.params },
            query: query.data,
            body: body.data,
          })
          if (isPadDownload(out)) {
            const bytes = files.get(`${inSpace}/${out.$padDownload.fileId}`)
            if (!bytes) return { status: 404, body: { error: 'not_found' } }
            const filename = safeDownloadName(out.$padDownload.filename, detectFileType(bytes))
            return { status: 200, body: {}, download: { filename, bytes } }
          }
          return { status: 200, body: out === undefined ? {} : JSON.parse(JSON.stringify(out)) }
        } catch (e) {
          if (stored) files.delete(`${inSpace}/${stored}`)
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
    /** Ids of the files stored for a Space. */
    files: (forSpace = spaceId) =>
      [...files.keys()].filter((k) => k.startsWith(`${forSpace}/`)).map((k) => k.split('/')[1]!),
    audit,
    logs,
    settings,
  }
}

export { z }
