import {
  CORE_API_VERSION,
  PadDataError,
  PadError,
  PadPermissionError,
  applyOps,
  collectOps,
  describePermission,
  satisfiesRange,
  schemaFromMigrations,
  touchesFinances,
  type PadContext,
  type PadEvent,
  type PadEventType,
  type PadModule,
  type PadSchema,
  type PadScope,
  type Role,
  type RouteHandler,
  type RouteOptions,
  type Schedule,
} from '@pond/sdk'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Logger } from 'pino'
import { recordAudit } from '../audit.js'
import type { Crypto } from '../crypto/index.js'
import type { EventBus } from '../events.js'
import { sendError } from '../http.js'
import { LedgerError, type Actor, type Deps } from '../ledger/service.js'
import type { createSpaceRouter } from '../middleware/spaceRouter.js'
import type { Repos } from '../repos/types.js'
import type { PadListing, PadStateName } from '@pond/shared'
import { createCoreFacade } from './core.js'
import { guardApi, jsonGuard, PadJsonError } from './json.js'
import { isDue, validateSchedule } from './schedule.js'
import { SettingError, describeSettings, getSetting, setSetting } from './settings.js'

/** Where the host finds pads. v1: a generated list of the official pads. Later: a runtime loader. */
export interface PadSource {
  list(): PadModule[]
}

export type { PadListing }
type PadState = PadStateName

type SpaceRouter = ReturnType<typeof createSpaceRouter>
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

interface DeclaredRoute {
  method: Method
  path: string
  opts: RouteOptions<unknown, unknown>
  handler: RouteHandler<unknown, unknown>
}
interface DeclaredJob {
  name: string
  schedule: Schedule
  handler: (scope: PadScope) => unknown
}
interface LoadedPad {
  module: PadModule
  schema: PadSchema
  state: PadState
  problem: string | null
  routes: Map<string, DeclaredRoute>
  events: { type: PadEventType; handler: (e: PadEvent, s: PadScope) => unknown }[]
  jobs: DeclaredJob[]
  failures: number
  /** Switched off after repeated failures; its routes answer 503 until Pond restarts. */
  tripped: boolean
}

export interface PadHostDeps {
  repos: Repos
  crypto: Crypto
  log: Logger
  now: () => Date
  newId: () => string
  timeZone: string
  events: EventBus
  source: PadSource
  /** Offer pads marked `devOnly` (the template pad). Off in production. */
  includeDevPads?: boolean
  /** Check that every call across the pad boundary is plain JSON. Always on in tests. */
  strictJson?: boolean
  /** Failures before a pad is switched off. */
  failureLimit?: number
}

/** Route paths a pad may not use: reserved for the host. */
const RESERVED_FIRST_SEGMENT = '_host'

export class PadHost {
  private loaded = new Map<string, LoadedPad>()
  private sp: SpaceRouter | null = null
  private mounted = new Set<string>()
  private readonly failureLimit: number

  constructor(private d: PadHostDeps) {
    this.failureLimit = d.failureLimit ?? 10
    d.events.subscribe((e) => this.dispatch(e))
  }

  // ---------- Discovery and state ----------

  private modules(): Map<string, PadModule> {
    return new Map(
      this.d.source
        .list()
        .filter((m) => !m.manifest.devOnly || this.d.includeDevPads)
        .map((m) => [m.manifest.id, m]),
    )
  }

  list(): PadListing[] {
    const installs = new Map(this.d.repos.pads.installs.list().map((i) => [i.padId, i]))
    return [...this.modules().values()]
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
      .map((m): PadListing => {
        const lp = this.loaded.get(m.manifest.id)
        const installed = installs.has(m.manifest.id)
        return {
          id: m.manifest.id,
          name: m.manifest.name,
          version: m.manifest.version,
          author: m.manifest.author,
          description: m.manifest.description ?? null,
          spaceTypes: m.manifest.spaceTypes,
          permissions: m.manifest.permissions.map((p) => ({
            permission: p,
            description: describePermission(p),
          })),
          touchesFinances: touchesFinances(m.manifest.permissions),
          installed,
          state: installed ? (lp?.state ?? 'error') : 'available',
          problem: installed ? (lp ? lp.problem : 'Not loaded') : null,
          enabledSpaceIds: installed
            ? this.d.repos.pads.enablement.spacesForPad(m.manifest.id)
            : [],
        }
      })
  }

  private running(padId: string): LoadedPad | undefined {
    const lp = this.loaded.get(padId)
    return lp && lp.state === 'running' ? lp : undefined
  }

  isEnabled(padId: string, spaceId: string): boolean {
    return !!this.running(padId) && this.d.repos.pads.enablement.isEnabled(padId, spaceId)
  }

  // ---------- Start-up ----------

  /** Loads every installed pad: checks, migrates, registers. A failing pad never stops the others. */
  async start(): Promise<void> {
    const modules = this.modules()
    for (const install of this.d.repos.pads.installs.list()) {
      const m = modules.get(install.padId)
      if (!m) {
        this.d.log.warn(
          { pad: install.padId },
          'installed LilyPad is not shipped with this version of Pond',
        )
        continue
      }
      await this.load(m)
    }
  }

  /** Check, migrate and register one pad. Records its state; never throws. */
  private async load(m: PadModule): Promise<LoadedPad> {
    const id = m.manifest.id
    const lp: LoadedPad = {
      module: m,
      schema: {},
      state: 'error',
      problem: null,
      routes: new Map(),
      events: [],
      jobs: [],
      failures: 0,
      tripped: false,
    }
    this.loaded.set(id, lp)
    const install = this.d.repos.pads.installs.get(id)
    try {
      if (!install) throw new Error('not installed')
      if (!satisfiesRange(CORE_API_VERSION, m.manifest.pondApi)) {
        lp.state = 'incompatible'
        lp.problem = `Needs Pond plugin API ${m.manifest.pondApi}; this Pond offers ${CORE_API_VERSION}`
        return lp
      }
      const granted = new Set(install.permissionsGranted)
      if (!m.manifest.permissions.every((p) => granted.has(p))) {
        lp.state = 'needs_approval'
        lp.problem = 'This version asks for permissions that have not been approved yet'
        return lp
      }
      lp.schema = schemaFromMigrations(m.migrations)
      this.migrate(m)
      if (install.version !== m.manifest.version)
        this.d.repos.pads.installs.upsert({ ...install, version: m.manifest.version })

      await m.server.register(this.contextFor(lp))
      lp.state = 'running'
      lp.problem = null
      this.mountRoutes(lp)
    } catch (e) {
      lp.state = 'error'
      lp.problem = e instanceof Error ? e.message.slice(0, 300) : 'Failed to start'
      this.d.log.error(
        { pad: id, err: { name: (e as Error)?.name, message: (e as Error)?.message } },
        'LilyPad failed to start',
      )
    }
    return lp
  }

  /** Runs pending migrations, each in one transaction with its record. Forward-only. */
  private migrate(m: PadModule): void {
    const id = m.manifest.id
    const applied = new Set(this.d.repos.pads.migrations.applied(id))
    const known = new Set(m.migrations.map((x) => x.name))
    for (const name of applied)
      if (!known.has(name))
        throw new Error(
          `Migration "${name}" was applied but this version of the pad no longer has it`,
        )
    for (const mig of m.migrations) {
      if (applied.has(mig.name)) continue
      const ops = collectOps(mig)
      applyOps(schemaFromMigrations(m.migrations.slice(0, m.migrations.indexOf(mig))), ops) // validate against the schema so far
      this.d.repos.transaction(() => {
        this.d.repos.padStore.applyOps(id, ops)
        this.d.repos.pads.migrations.record(id, mig.name, this.d.now().toISOString())
      })
    }
  }

  // ---------- What a pad registers ----------

  private contextFor(lp: LoadedPad): PadContext {
    const id = lp.module.manifest.id
    const add =
      (method: Method) =>
      (
        path: string,
        opts: RouteOptions<unknown, unknown>,
        handler: RouteHandler<unknown, unknown>,
      ) => {
        if (
          !path.startsWith('/') ||
          path.split('/')[1] === RESERVED_FIRST_SEGMENT ||
          /[^A-Za-z0-9_:/-]/.test(path)
        ) {
          throw new Error(`Bad route path "${path}"`)
        }
        if (!opts || !['viewer', 'editor', 'owner'].includes(opts.role))
          throw new Error(`Route ${path} must declare a role`)
        const key = `${method} ${path}`
        if (lp.routes.has(key)) throw new Error(`Route declared twice: ${key}`)
        lp.routes.set(key, { method, path, opts, handler })
      }
    return {
      manifest: lp.module.manifest,
      router: {
        get: add('get'),
        post: add('post'),
        put: add('put'),
        patch: add('patch'),
        delete: add('delete'),
      } as unknown as PadContext['router'],
      events: { on: (type, handler) => void lp.events.push({ type, handler: handler as never }) },
      jobs: {
        schedule: (name, schedule, handler) => {
          validateSchedule(schedule)
          if (lp.jobs.some((j) => j.name === name)) throw new Error(`Job declared twice: ${name}`)
          lp.jobs.push({ name, schedule, handler })
        },
      },
      log: this.padLog(id),
    }
  }

  private padLog(padId: string): PadScope['log'] {
    const child = this.d.log.child({ pad: padId })
    return {
      debug: (m, data) => child.debug(data ?? {}, m),
      info: (m, data) => child.info(data ?? {}, m),
      warn: (m, data) => child.warn(data ?? {}, m),
      error: (m, data) => child.error(data ?? {}, m),
    }
  }

  // ---------- Scopes: what a handler is given ----------

  private deps(): Deps {
    return { repos: this.d.repos, newId: this.d.newId, now: this.d.now, events: this.d.events }
  }

  buildScope(
    lp: LoadedPad,
    o: { spaceId: string; role: Role | null; user: PadScope['user'] },
  ): PadScope {
    const m = lp.module.manifest
    const id = m.id
    const strict = this.d.strictJson === true
    const space = this.d.repos.spaces.findById(o.spaceId)
    if (!space) throw new PadError(404, 'not_found')
    const grants = new Set<string>(m.permissions)
    const need = (p: string) => {
      if (!grants.has(p)) throw new PadPermissionError(p)
    }
    return {
      padId: id,
      space: { id: space.id, type: space.type, role: o.role },
      user: o.user,
      core: guardApi('core', createCoreFacade(this.deps(), grants, space.id), strict),
      db: {
        table: ((name: string) => {
          if (typeof name !== 'string')
            throw new PadDataError('unknown_table', 'Table name must be text')
          return guardApi(
            `db.${name}`,
            this.d.repos.padStore.table(id, lp.schema, name, space.id),
            strict,
          )
        }) as PadScope['db']['table'],
      },
      settings: {
        get: (async (key: string) =>
          getSetting(this.d.repos, m, space.id, key)) as PadScope['settings']['get'],
        set: async (key, value) => {
          // Only a Space owner's own request may change a Space setting.
          if (o.role !== 'owner') throw new PadError(403, 'forbidden')
          setSetting(this.d.repos, m, space.id, key, value)
        },
      },
      secrets: {
        encrypt: async (t) => (need('secrets:use'), this.d.crypto.encrypt(t)),
        decrypt: async (s) => (need('secrets:use'), this.d.crypto.decrypt(s)),
      },
      audit: {
        record: async (e) =>
          recordAudit(
            this.d.repos.audit,
            {
              actorType: 'lilypad',
              actorId: id,
              action: `lilypad.${id}.${e.action}`,
              targetType: e.targetType,
              targetId: e.targetId,
              spaceId: space.id,
              meta: e.meta,
            },
            this.d.now(),
            this.d.newId,
          ),
      },
      log: this.padLog(id),
      newId: this.d.newId,
    }
  }

  // ---------- Routes ----------

  /** Called once from the Spaces router so pad routes get the same middleware as core routes. */
  attachRouter(sp: SpaceRouter): void {
    this.sp = sp
    for (const lp of this.loaded.values()) if (lp.state === 'running') this.mountRoutes(lp)
  }

  private mountRoutes(lp: LoadedPad): void {
    const sp = this.sp
    if (!sp) return
    const id = lp.module.manifest.id
    for (const [key, route] of lp.routes) {
      const fullPath = `/lilypads/${id}${route.path === '/' ? '' : route.path}`
      const mountKey = `${key.split(' ')[0]} ${fullPath}`
      if (this.mounted.has(mountKey)) continue
      this.mounted.add(mountKey)
      // Resolved on every request, so uninstalling or switching a pad off takes effect at once.
      const gate: RequestHandler = (req, res, next) => {
        const live = this.loaded.get(id)
        if (
          !live ||
          live.state !== 'running' ||
          !this.d.repos.pads.enablement.isEnabled(id, req.space!.id)
        )
          return sendError(res, 404, 'not_found')
        if (live.tripped) return sendError(res, 503, 'pad_unavailable')
        next()
      }
      sp[route.method](
        fullPath,
        route.opts.role,
        gate,
        (req: Request, res: Response, next: NextFunction) => {
          void this.handle(id, key, req, res).catch(next)
        },
      )
    }
  }

  private async handle(padId: string, key: string, req: Request, res: Response): Promise<void> {
    const lp = this.running(padId)
    const route = lp?.routes.get(key)
    if (!lp || !route) return sendError(res, 404, 'not_found')

    const body = route.opts.body
      ? route.opts.body.safeParse(req.body)
      : { success: true as const, data: req.body as unknown }
    const query = route.opts.query
      ? route.opts.query.safeParse(req.query)
      : { success: true as const, data: req.query as unknown }
    if (!body.success || !query.success) {
      const issues = [
        ...(body.success ? [] : body.error.issues),
        ...(query.success ? [] : query.error.issues),
      ]
      return sendError(res, 400, 'invalid_input', {
        issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    try {
      const u = req.auth!.user
      const scope = this.buildScope(lp, {
        spaceId: req.space!.id,
        role: req.space!.role,
        user: { id: u.id, username: u.username, displayName: u.displayName },
      })
      const out = await route.handler({
        ...scope,
        params: Object.fromEntries(
          Object.entries(req.params)
            .filter(([k]) => k !== 'spaceId')
            .map(([k, v]) => [k, String(v)]),
        ),
        query: query.data,
        body: body.data,
      })
      res.json(out === undefined ? {} : out)
    } catch (e) {
      this.respondToFailure(padId, e, res)
    }
  }

  /** Expected errors become their own responses; anything else is a pad bug: counted, logged, a plain 500. */
  private respondToFailure(padId: string, e: unknown, res: Response): void {
    if (e instanceof PadError) return void sendError(res, e.status, e.code)
    if (e instanceof PadPermissionError) return void sendError(res, 403, 'pad_permission_denied')
    if (e instanceof PadDataError) return void sendError(res, 400, e.code)
    if (e instanceof SettingError) return void sendError(res, 400, e.code)
    if (e instanceof LedgerError) return void sendError(res, e.status, e.code)
    this.recordFailure(padId, e)
    sendError(res, 500, 'internal_error')
  }

  /** Counts a pad bug. After too many, the pad is switched off until Pond restarts. */
  recordFailure(padId: string, e: unknown): void {
    const lp = this.loaded.get(padId)
    this.d.log.error(
      { pad: padId, err: { name: (e as Error)?.name, message: (e as Error)?.message } },
      'LilyPad handler failed',
    )
    if (!lp) return
    lp.failures++
    if (!lp.tripped && lp.failures >= this.failureLimit) {
      lp.tripped = true
      lp.problem = 'Switched off after repeated errors'
      recordAudit(
        this.d.repos.audit,
        {
          actorType: 'system',
          action: 'lilypad.auto_disabled',
          targetType: 'lilypad',
          targetId: padId,
          meta: { failures: lp.failures },
        },
        this.d.now(),
        this.d.newId,
      )
    }
  }

  // ---------- Events and jobs ----------

  private async dispatch(e: PadEvent): Promise<void> {
    for (const lp of this.loaded.values()) {
      const id = lp.module.manifest.id
      if (
        lp.state !== 'running' ||
        lp.tripped ||
        !this.d.repos.pads.enablement.isEnabled(id, e.spaceId)
      )
        continue
      for (const h of lp.events.filter((x) => x.type === e.type)) {
        try {
          await h.handler(e, this.buildScope(lp, { spaceId: e.spaceId, role: null, user: null }))
        } catch (err) {
          this.recordFailure(id, err)
        }
      }
    }
  }

  /** Runs every job that is due, once per enabled Space. Returns how many ran. */
  async runDueJobs(): Promise<number> {
    const now = this.d.now()
    let ran = 0
    for (const lp of this.loaded.values()) {
      const id = lp.module.manifest.id
      if (lp.state !== 'running' || lp.tripped) continue
      for (const job of lp.jobs) {
        for (const spaceId of this.d.repos.pads.enablement.spacesForPad(id)) {
          const last = this.d.repos.pads.jobRuns.get(id, job.name, spaceId)
          if (!last) {
            this.d.repos.pads.jobRuns.set(id, job.name, spaceId, now.toISOString()) // first sighting: start the clock
            continue
          }
          if (!isDue(job.schedule, new Date(last), now, this.d.timeZone)) continue
          this.d.repos.pads.jobRuns.set(id, job.name, spaceId, now.toISOString()) // record first: a crash won't loop
          try {
            await job.handler(this.buildScope(lp, { spaceId, role: null, user: null }))
            ran++
          } catch (err) {
            this.recordFailure(id, err)
          }
        }
      }
    }
    return ran
  }

  // ---------- Lifecycle (admin and Space owners) ----------

  private audit(
    actor: Actor,
    action: string,
    padId: string,
    spaceId?: string,
    meta?: Record<string, unknown>,
  ) {
    recordAudit(
      this.d.repos.audit,
      { actorId: actor.id, action, targetType: 'lilypad', targetId: padId, spaceId, meta },
      this.d.now(),
      this.d.newId,
    )
  }

  private module(padId: string): PadModule {
    const m = this.modules().get(padId)
    if (!m) throw new LedgerError(404, 'not_found')
    return m
  }

  /** Admin: approve the pad's permissions and start it. Also how an update with new permissions is re-approved. */
  async install(actor: Actor, padId: string, approved: string[]): Promise<PadListing> {
    const m = this.module(padId)
    if (!satisfiesRange(CORE_API_VERSION, m.manifest.pondApi))
      throw new LedgerError(409, 'incompatible')
    const want = [...m.manifest.permissions].sort()
    const got = [...new Set(approved)].sort()
    if (want.length !== got.length || want.some((p, i) => p !== got[i]))
      throw new LedgerError(409, 'permissions_mismatch', { required: want })
    const existing = this.d.repos.pads.installs.get(padId)
    this.d.repos.pads.installs.upsert({
      padId,
      version: m.manifest.version,
      tier: 'official',
      permissionsGranted: want,
      installedBy: existing?.installedBy ?? actor.id,
      installedAt: existing?.installedAt ?? this.d.now().toISOString(),
      enabled: true,
    })
    await this.load(m)
    this.audit(actor, existing ? 'lilypad.updated' : 'lilypad.installed', padId, undefined, {
      version: m.manifest.version,
    })
    return this.list().find((l) => l.id === padId)!
  }

  /** Admin: stop and remove a pad; optionally delete its data (otherwise a later install finds it intact). */
  uninstall(actor: Actor, padId: string, deleteData: boolean): void {
    const m = this.module(padId)
    if (!this.d.repos.pads.installs.get(padId)) throw new LedgerError(404, 'not_found')
    const lp = this.loaded.get(padId)
    this.loaded.delete(padId)
    this.d.repos.transaction(() => {
      this.d.repos.pads.enablement.removeAllForPad(padId)
      this.d.repos.pads.jobRuns.removeAllForPad(padId)
      this.d.repos.pads.installs.delete(padId)
      if (deleteData) {
        this.d.repos.padStore.dropPad(padId, lp?.schema ?? schemaFromMigrations(m.migrations))
        this.d.repos.pads.migrations.removeAllForPad(padId)
        this.d.repos.settings.deleteByPrefix(`lp.${padId}.`)
      }
    })
    this.audit(actor, 'lilypad.uninstalled', padId, undefined, { deletedData: deleteData })
  }

  /** Space owner: turn a pad on or off for a Space. */
  setEnabled(actor: Actor, spaceId: string, padId: string, enabled: boolean): void {
    const lp = this.running(padId)
    if (!lp) throw new LedgerError(404, 'not_found')
    const space = this.d.repos.spaces.findById(spaceId)
    if (!space) throw new LedgerError(404, 'not_found')
    if (enabled) {
      if (!lp.module.manifest.spaceTypes.includes(space.type))
        throw new LedgerError(400, 'space_type_not_supported')
      this.d.repos.pads.enablement.enable(padId, spaceId, actor.id, this.d.now().toISOString())
    } else {
      this.d.repos.pads.enablement.disable(padId, spaceId)
    }
    this.audit(actor, enabled ? 'lilypad.enabled' : 'lilypad.disabled', padId, spaceId)
  }

  /** Pads running in this Space, for the web shell (sidebar, dashboard, panels). */
  listForSpace(spaceId: string) {
    return this.d.repos.pads.enablement.padsForSpace(spaceId).flatMap((id) => {
      const lp = this.running(id)
      return lp && !lp.tripped
        ? [{ id, name: lp.module.manifest.name, version: lp.module.manifest.version }]
        : []
    })
  }

  /** Installed pads this Space's type allows, with whether each is on (the owner's switch list). */
  availableForSpace(spaceId: string) {
    const space = this.d.repos.spaces.findById(spaceId)
    if (!space) throw new LedgerError(404, 'not_found')
    return this.d.repos.pads.installs.list().flatMap((i) => {
      const lp = this.running(i.padId)
      if (!lp || !lp.module.manifest.spaceTypes.includes(space.type)) return []
      const m = lp.module.manifest
      return [
        {
          id: m.id,
          name: m.name,
          description: m.description ?? null,
          touchesFinances: touchesFinances(m.permissions),
          enabled: this.d.repos.pads.enablement.isEnabled(m.id, spaceId),
          hasSettings: m.settings.some((s) => s.scope === 'space'),
        },
      ]
    })
  }

  /** The settings screen data for one pad: fields and current values. */
  settingsFor(padId: string, spaceId: string, scope: 'space' | 'global') {
    const lp = this.running(padId)
    if (!lp) throw new LedgerError(404, 'not_found')
    return {
      padId,
      name: lp.module.manifest.name,
      fields: describeSettings(this.d.repos, lp.module.manifest, spaceId, scope),
    }
  }

  saveSettings(
    padId: string,
    spaceId: string,
    scope: 'space' | 'global',
    values: Record<string, unknown>,
  ): void {
    const lp = this.running(padId)
    if (!lp) throw new LedgerError(404, 'not_found')
    const m = lp.module.manifest
    for (const key of Object.keys(values)) {
      const f = m.settings.find((s) => s.key === key)
      if (!f || f.scope !== scope)
        throw new SettingError('wrong_scope', `"${key}" isn't a ${scope} setting`)
    }
    for (const [key, value] of Object.entries(values))
      setSetting(this.d.repos, m, spaceId, key, value)
  }
}

export { PadJsonError, jsonGuard }
