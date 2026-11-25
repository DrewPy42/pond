import { randomBytes } from 'node:crypto'
import type { Express } from 'express'
import { generateSync } from 'otplib'
import request from 'supertest'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../app.js'
import { createGatedFileStore } from '../backup/fileGate.js'
import { BackupLock } from '../backup/lock.js'
import { backupPaths, type BackupPaths } from '../backup/paths.js'
import { RestoreService } from '../backup/restore.js'
import { createSafetyCopies } from '../backup/safety.js'
import { BackupService } from '../backup/service.js'
import { LoginLimiter } from '../auth/ratelimit.js'
import { SetupCode } from '../auth/setupCode.js'
import type { AppContext } from '../context.js'
import { createCrypto } from '../crypto/index.js'
import { createEventBus, type EventBus } from '../events.js'
import { PadHost } from '../lilypads/host.js'
import { createLogger } from '../logger.js'
import type { PadModule } from '@pond/sdk'
import { createFakeBackupDb } from './fakeBackupDb.js'
import { createFakeFileStore } from './fakeFiles.js'
import { createFakeRepos } from './fakeRepos.js'
import { FakeSimpleFin } from './fakeSimpleFin.js'

export const PASSWORD = 'correct-horse-battery-1'

export interface TestEnv {
  ctx: AppContext
  /** Core events (delivered asynchronously: `await env.events.whenIdle()` before asserting). */
  events: EventBus
  padHost: PadHost
  /** The in-memory file store pad uploads go to. */
  files: ReturnType<typeof createFakeFileStore>
  /** Script what the "bank" returns and inspect what we asked. */
  simplefin: FakeSimpleFin
  app: Express
  /** How often Pond was asked to restart (to apply a restore). */
  restarts(): number
  /** Where backups go. Nothing is created unless a test asks for it. */
  paths: BackupPaths
  /** Move the injected clock forward. */
  advance(ms: number): void
}

/**
 * A complete app wired to in-memory fake repositories (no database), a fixed clock you can
 * advance, predictable ids (`id-1`, `id-2`, ...) and a random throwaway crypto key.
 */
export function makeEnv(
  opts: {
    withSetupCode?: boolean
    pads?: PadModule[]
    padFailureLimit?: number
    /** A temporary folder, for tests that make or restore backups. */
    dataDir?: string
    backupFolder?: string
  } = {},
): TestEnv {
  let t = Date.parse('2026-01-01T12:00:00Z')
  const clock = () => t
  let idCounter = 0
  const simplefin = new FakeSimpleFin()
  const repos = createFakeRepos(() => new Date(t))
  const log = createLogger('silent')
  const events = createEventBus()
  const files = createFakeFileStore()
  const padHost = new PadHost({
    repos,
    crypto: createCrypto(randomBytes(32)),
    log,
    now: () => new Date(t),
    newId: () => `pad-id-${++idCounter}`,
    timeZone: 'UTC',
    events,
    source: { list: () => opts.pads ?? [] },
    files,
    includeDevPads: true,
    strictJson: true, // every call between a pad and Pond must be plain JSON
    failureLimit: opts.padFailureLimit,
  })
  const paths = backupPaths(
    opts.dataDir ?? path.join(os.tmpdir(), `pond-unused-${randomBytes(8).toString('hex')}`),
    opts.backupFolder ?? null,
  )
  const crypto = createCrypto(randomBytes(32))
  const backupDb = createFakeBackupDb()
  const gate = createGatedFileStore(files)
  const lock = new BackupLock()
  let restarts = 0
  const newId = () => `id-${++idCounter}`
  const backups = new BackupService({
    repos,
    crypto,
    db: backupDb,
    paths,
    gate,
    lock,
    now: () => new Date(t),
    newId,
    timeZone: 'UTC',
    pondVersion: '0.0.0',
    workFactor: 10, // fast: the real strength is tested separately
  })
  const restores = new RestoreService({
    db: backupDb,
    paths,
    lock,
    safety: createSafetyCopies({ db: backupDb, paths, now: () => new Date(t), gate }),
    newId,
    maxUploadBytes: 5 * 1024 * 1024,
    shippedPads: () => new Map(),
  })
  const ctx: AppContext = {
    repos,
    crypto,
    log,
    setupCode: new SetupCode(opts.withSetupCode ?? true),
    limiter: new LoginLimiter({ clock }),
    cookieSecure: false,
    now: () => new Date(t),
    newId,
    events,
    backups,
    restores,
    restart: () => void restarts++,
    padHost,
    simplefin,
    timeZone: 'UTC',
    spaceRoutes: [],
  }
  return {
    ctx,
    events,
    padHost,
    files,
    simplefin,
    app: createApp(ctx),
    paths,
    restarts: () => restarts,
    advance: (ms) => void (t += ms),
  }
}

export interface Res {
  status: number
  body: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string | string[] | undefined>
}

/** A tiny cookie-jar client that echoes the CSRF cookie in the x-csrf-token header. */
export class Client {
  jar = new Map<string, string>()
  constructor(
    private readonly app: Express,
    private readonly ip = '10.0.0.1',
  ) {}

  async send(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: object,
    opts: { csrf?: boolean } = {},
  ): Promise<Res> {
    let r = request(this.app)[method](path).set('X-Forwarded-For', this.ip)
    const cookie = [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
    if (cookie) r = r.set('Cookie', cookie)
    const csrf = this.jar.get('pond_csrf')
    if (csrf && opts.csrf !== false && method !== 'get') r = r.set('x-csrf-token', csrf)
    const res = await (body ? r.send(body) : r)
    for (const c of (res.headers['set-cookie'] as unknown as string[] | undefined) ?? []) {
      const [pair = ''] = c.split(';')
      const i = pair.indexOf('=')
      const name = pair.slice(0, i)
      const value = decodeURIComponent(pair.slice(i + 1))
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(name)
      else this.jar.set(name, value)
    }
    return { status: res.status, body: res.body, headers: res.headers }
  }
  get = (p: string) => this.send('get', p)
  post = (p: string, b?: object) => this.send('post', p, b ?? {})
  put = (p: string, b?: object) => this.send('put', p, b ?? {})
  patch = (p: string, b?: object) => this.send('patch', p, b ?? {})
  delete = (p: string) => this.send('delete', p)
}

export const totpNow = (secret: string): string => generateSync({ secret })

export interface Account {
  client: Client
  username: string
  id: string
  secret?: string
  recoveryCodes?: string[]
}

/** Run first-run setup and finish TOTP enrollment, returning a fully signed-in admin. */
export async function bootstrapAdmin(env: TestEnv, username = 'admin'): Promise<Account> {
  const client = new Client(env.app, '10.0.0.1')
  const setup = await client.post('/api/setup', {
    setupCode: env.ctx.setupCode.reveal(),
    username,
    displayName: 'Admin',
    password: PASSWORD,
  })
  if (setup.status !== 201)
    throw new Error(`setup failed: ${setup.status} ${JSON.stringify(setup.body)}`)
  const enroll = await client.post('/api/auth/totp/enroll')
  const confirm = await client.post('/api/auth/totp/confirm', { code: totpNow(enroll.body.secret) })
  return {
    client,
    username,
    id: setup.body.user.id,
    secret: enroll.body.secret,
    recoveryCodes: confirm.body.recoveryCodes,
  }
}

/** Admin creates a regular user; returns a signed-in client for that user (no TOTP). */
export async function createUser(
  env: TestEnv,
  admin: Account,
  username: string,
  ip = '10.0.0.2',
): Promise<Account> {
  const created = await admin.client.post('/api/users', {
    username,
    displayName: username,
    password: PASSWORD,
  })
  if (created.status !== 201)
    throw new Error(`create user failed: ${created.status} ${JSON.stringify(created.body)}`)
  const client = new Client(env.app, ip)
  const login = await client.post('/api/auth/login', { username, password: PASSWORD })
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`)
  return { client, username, id: created.body.user.id }
}
