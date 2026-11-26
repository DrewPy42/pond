import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Router, type Request, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import { BackupError, type BackupErrorCode } from '../backup/errors.js'
import { MAX_SETUP_LENGTH } from '../backup/remote/setup.js'
import type { AppContext } from '../context.js'
import { sendError, validateBody } from '../http.js'
import { requireAdmin, requireAuth, requireRecentReauth } from '../middleware/auth.js'

const STATUS: Record<BackupErrorCode, number> = {
  passphrase_not_set: 409,
  weak_passphrase: 400,
  busy: 409,
  restore_pending: 409,
  folder_not_available: 409,
  folder_marker_missing: 409,
  destination_required: 400,
  bad_remote_setup: 400,
  bad_remote_folder: 400,
  remote_not_available: 409,
  remote_not_set_up: 409,
  remote_paused: 409,
  remote_sign_in_failed: 502,
  remote_unreachable: 502,
  remote_full: 507,
  remote_failed: 502,
  remote_upload_unconfirmed: 502,
  not_enough_space: 507,
  too_large: 413,
  upload_failed: 400,
  wrong_passphrase: 400,
  not_a_backup: 400,
  damaged_backup: 400,
  newer_backup: 409,
  key_mismatch: 400,
  restore_expired: 409,
  safety_copy_failed: 500,
  backup_failed: 500,
}

const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res)
    } catch (e) {
      if (!(e instanceof BackupError)) return next(e)
      req.resume() // let an unread upload drain so the answer arrives
      sendError(res, STATUS[e.code], e.code, e.detail ? { message: e.detail } : undefined)
    }
  }

const passphrase = z.string().min(1).max(256)
const uploadRef = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
const checkBody = z.object({ uploadId: uploadRef, passphrase })
/** `replaceEverything` makes the destructive step impossible to send by accident. */
const confirmBody = z.object({ uploadId: uploadRef, replaceEverything: z.literal(true) })

/** The upload and check steps, shared by Settings and the first-run screen. */
function restoreSteps(ctx: AppContext) {
  return {
    upload: handle(async (req, res) => {
      if (!req.is('application/octet-stream') || req.headers['content-encoding'])
        return sendError(res, 415, 'unsupported_content_type')
      res.status(201).json(await ctx.restores.receive(req, Number(req.headers['content-length'])))
    }),
    check: [
      validateBody(checkBody),
      handle(async (req, res) => {
        const b = req.body as z.infer<typeof checkBody>
        res.json({ summary: await ctx.restores.check(b.uploadId, b.passphrase) })
      }),
    ],
    confirm: (requestedBy: (req: Request) => string | null) => [
      validateBody(confirmBody),
      handle(async (req, res) => {
        const b = req.body as z.infer<typeof confirmBody>
        await ctx.restores.confirm(b.uploadId, requestedBy(req))
        // Restart only once the answer has gone out.
        res.on('finish', () => ctx.restart())
        res.status(202).json({ restarting: true })
      }),
    ],
  }
}

/** Admin backup routes. Everything that reads, writes or replaces data needs the password again. */
export function backupsRouter(ctx: AppContext): Router {
  const r = Router()
  const reauth = requireRecentReauth(ctx.now)
  const steps = restoreSteps(ctx)
  const actor = (req: Request) => req.auth!.user.id
  r.use(requireAuth(), requireAdmin)

  r.get(
    '/',
    handle(async (_req, res) => res.json(await ctx.backups.view())),
  )

  r.put(
    '/passphrase',
    reauth,
    validateBody(z.object({ passphrase })),
    handle(async (req, res) => {
      ctx.backups.setPassphrase(actor(req), (req.body as { passphrase: string }).passphrase)
      res.json(await ctx.backups.view())
    }),
  )

  const settingsBody = z.object({
    folderEnabled: z.boolean(),
    keep: z.number().int().min(1).max(365),
    schedule: z.object({
      enabled: z.boolean(),
      frequency: z.enum(['daily', 'weekly']),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      weekday: z.number().int().min(0).max(6),
    }),
  })
  r.put(
    '/settings',
    reauth,
    validateBody(settingsBody),
    handle(async (req, res) => {
      await ctx.backups.saveSettings(actor(req), req.body as z.infer<typeof settingsBody>)
      res.json(await ctx.backups.view())
    }),
  )

  r.post(
    '/run',
    reauth,
    validateBody(z.object({ destination: z.enum(['download', 'folder', 'remote']) })),
    handle(async (req, res) => {
      const { destination } = req.body as { destination: 'download' | 'folder' | 'remote' }
      if (destination === 'folder') res.json(await ctx.backups.backupToFolder(actor(req)))
      else if (destination === 'remote') res.json(await ctx.backups.backupToRemote(actor(req)))
      else res.json(await ctx.backups.backupForDownload(actor(req), req.auth!.sessionId))
    }),
  )

  // `setup` is the pasted rclone text. It is never returned, logged or audited.
  const remoteBody = z.object({
    setup: z.string().min(1).max(MAX_SETUP_LENGTH).optional(),
    folder: z.string().min(1).max(400),
    enabled: z.boolean(),
  })
  r.put(
    '/remote',
    reauth,
    validateBody(remoteBody),
    handle(async (req, res) => {
      await ctx.backups.saveRemote(actor(req), req.body as z.infer<typeof remoteBody>)
      res.json(await ctx.backups.view())
    }),
  )
  r.delete(
    '/remote',
    reauth,
    handle(async (req, res) => {
      ctx.backups.removeRemote(actor(req))
      res.json(await ctx.backups.view())
    }),
  )

  // No second password prompt: the id is single-use, unguessable and belongs to the session
  // that passed the re-check to make it (a big backup can outlast the 5-minute window).
  r.get(
    '/download/:downloadId',
    handle(async (req, res) => {
      const item = await ctx.backups.takeDownload(
        actor(req),
        req.auth!.sessionId,
        String(req.params.downloadId),
      )
      if (!item) return sendError(res, 404, 'not_found')
      try {
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Disposition', `attachment; filename="${item.filename}"`)
        res.setHeader('Content-Length', (await fsp.stat(item.path)).size)
        res.setHeader('Cache-Control', 'no-store')
        await pipeline(fs.createReadStream(item.path), res).catch(() => {})
      } finally {
        await fsp.rm(item.path, { force: true })
      }
    }),
  )

  r.post('/restore/upload', reauth, steps.upload)
  r.post('/restore/check', reauth, ...steps.check)
  r.post('/restore/confirm', reauth, ...steps.confirm((req) => req.auth!.user.username))
  return r
}

/**
 * Restore on a brand-new install, from the first-run screen: the main disaster case. It needs the
 * setup code from the server console, like creating the first admin, and closes as soon as any
 * account exists.
 */
export function setupRestoreRouter(ctx: AppContext): Router {
  const r = Router()
  const steps = restoreSteps(ctx)
  const gate: RequestHandler = (req, res, next) => {
    if (!ctx.setupCode.active || ctx.repos.users.count() > 0)
      return sendError(res, 404, 'not_found')
    const key = `setup:${req.ip ?? 'unknown'}`
    const wait = ctx.limiter.retryAfterMs(key)
    if (wait > 0) {
      res.setHeader('Retry-After', Math.ceil(wait / 1000))
      return sendError(res, 429, 'too_many_attempts')
    }
    // Checked before any of the body is read.
    if (!ctx.setupCode.verify(req.header('x-setup-code') ?? '')) {
      ctx.limiter.fail(key)
      return sendError(res, 403, 'invalid_setup_code')
    }
    next()
  }
  r.post('/upload', gate, steps.upload)
  r.post('/check', gate, ...steps.check)
  r.post('/confirm', gate, ...steps.confirm(() => null))
  return r
}
