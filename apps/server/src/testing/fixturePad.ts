import {
  PadError,
  definePad,
  defineMigration,
  definePadModule,
  manifestSchema,
  z,
  type Permission,
  type PadModule,
} from '@pond/sdk'

/**
 * A pad that exists only for tests of the host. It has routes that exercise every rule the host
 * enforces: roles, validation, Space scoping, undeclared tables, permissions, failures, events,
 * jobs, settings, secrets and audit. (The Notes template pad is the friendly example; this one is
 * the adversary.)
 */
export interface FixtureOptions {
  id?: string
  version?: string
  permissions?: Permission[]
  spaceTypes?: ('personal' | 'business')[]
  pondApi?: string
  /** Make `register` throw. */
  failRegister?: boolean
  /** Make the transaction.created handler throw. */
  failEvents?: boolean
  /** Record what the pad's handlers did, for assertions. */
  log?: {
    events: { type: string; spaceId: string; userId: string | null; role: string | null }[]
    jobs: { spaceId: string }[]
  }
}

export function makeFixturePad(o: FixtureOptions = {}): PadModule {
  const id = o.id ?? 'fixture'
  const log = o.log ?? { events: [], jobs: [] }
  const manifest = manifestSchema.parse({
    id,
    name: `Fixture ${id}`,
    version: o.version ?? '1.0.0',
    author: 'Tests',
    license: 'MIT',
    description: 'Test pad',
    pondApi: o.pondApi ?? '^1.0',
    spaceTypes: o.spaceTypes ?? ['personal', 'business'],
    permissions: o.permissions ?? [
      'transactions:read',
      'accounts:read',
      'balances:read',
      'spaces:read',
      'secrets:use',
    ],
    settings: [
      { key: 'greeting', label: 'Greeting', type: 'string', default: 'hello', scope: 'space' },
      {
        key: 'limit',
        label: 'Limit',
        type: 'integer',
        default: 5,
        min: 1,
        max: 10,
        scope: 'space',
      },
      {
        key: 'mode',
        label: 'Mode',
        type: 'choice',
        default: 'a',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        scope: 'space',
      },
      { key: 'adminOnly', label: 'Admin only', type: 'boolean', default: false, scope: 'global' },
    ],
  })

  const server = definePad({
    register(ctx) {
      if (o.failRegister) throw new Error('register exploded')

      ctx.router.get('/notes', { role: 'viewer' }, async (req) => ({
        notes: await req.db.table('notes').find({ orderBy: [['created_at', 'asc']] }),
      }))
      ctx.router.post(
        '/notes',
        { role: 'editor', body: z.object({ title: z.string().min(1).max(50) }) },
        async (req) => ({ note: await req.db.table('notes').insert({ title: req.body.title }) }),
      )
      ctx.router.get('/whoami', { role: 'viewer' }, async (req) => ({
        user: req.user?.username ?? null,
        role: req.space.role,
        space: req.space.id,
        type: req.space.type,
        params: req.params,
      }))
      ctx.router.get(
        '/items/:itemId',
        { role: 'viewer', query: z.object({ n: z.coerce.number().int().optional() }) },
        async (req) => ({ itemId: req.params.itemId, n: req.query.n ?? null }),
      )
      ctx.router.get('/missing', { role: 'viewer' }, async () => {
        throw new PadError(404, 'no_such_thing')
      })

      // ---- Things a misbehaving pad might try ----
      ctx.router.get('/bad-table', { role: 'viewer' }, async (req) => ({
        rows: await req.db
          .table(
            String(
              req.query && (req.query as { t?: string }).t
                ? (req.query as { t: string }).t
                : 'users',
            ),
          )
          .find(),
      }))
      ctx.router.get('/boom', { role: 'viewer' }, async () => {
        throw new Error('secret internal detail')
      })
      ctx.router.post('/date-bug', { role: 'editor' }, async (req) => ({
        note: await req.db.table('notes').insert({ title: 'x', body: new Date() as never }),
      }))

      // ---- Core access ----
      ctx.router.get('/core/transactions', { role: 'viewer' }, async (req) =>
        req.core.transactions.list({ limit: 50 }),
      )
      ctx.router.get('/core/accounts', { role: 'viewer' }, async (req) => ({
        accounts: await req.core.accounts.list(),
      }))
      ctx.router.get('/core/space', { role: 'viewer' }, async (req) => req.core.spaces.get())
      ctx.router.get('/core/sum', { role: 'viewer' }, async (req) => ({
        rows: await req.core.splits.sum({
          from: '2030-01-01',
          to: '2030-12-31',
          groupBy: 'category',
        }),
      }))
      ctx.router.get('/core/balances', { role: 'viewer' }, async (req) => ({
        balances: await req.core.balances.latest(),
      }))

      // ---- Settings, secrets, audit ----
      ctx.router.get('/setting/:key', { role: 'viewer' }, async (req) => ({
        value: await req.settings.get(req.params.key!),
      }))
      ctx.router.put(
        '/setting/:key',
        {
          role: 'viewer',
          body: z.object({ value: z.union([z.string(), z.number(), z.boolean()]) }),
        },
        async (req) => {
          await req.settings.set(req.params.key!, req.body.value)
          return { ok: true }
        },
      )
      ctx.router.post(
        '/secret',
        { role: 'editor', body: z.object({ text: z.string() }) },
        async (req) => {
          const enc = await req.secrets.encrypt(req.body.text)
          return { enc, dec: await req.secrets.decrypt(enc) }
        },
      )
      ctx.router.post('/audit', { role: 'editor' }, async (req) => {
        await req.audit.record({
          action: 'did_thing',
          targetType: 'thing',
          targetId: 't1',
          meta: { count: 2, password: 'hunter2' },
        })
        return { ok: true }
      })

      ctx.events.on('transaction.created', async (e, scope) => {
        if (o.failEvents) throw new Error('handler exploded')
        log.events.push({
          type: e.type,
          spaceId: scope.space.id,
          userId: scope.user?.id ?? null,
          role: scope.space.role,
        })
        await scope.db.table('notes').insert({ title: `event ${e.transactionId}` })
      })
      ctx.events.on('space.created', async (e, scope) => {
        log.events.push({ type: e.type, spaceId: scope.space.id, userId: null, role: null })
      })
      ctx.jobs.schedule('monthly', { monthly: { day: 1, at: '06:00' } }, async (scope) => {
        log.jobs.push({ spaceId: scope.space.id })
      })
    },
  })

  return definePadModule({
    manifest,
    migrations: [
      defineMigration('0001_init', (m) => {
        m.createTable('notes', {
          columns: { title: 'text', body: { type: 'json', nullable: true } },
        })
      }),
    ],
    server,
  })
}
