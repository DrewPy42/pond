import { detectFileType, mimeOf, safeDownloadName, type UploadSpec } from '@pond/sdk'
import express, { type RequestHandler, type Response } from 'express'
import { sendError } from '../http.js'

/**
 * Reads a file sent as the raw request body. It runs only after sign-in, CSRF, the Space role and
 * pad enablement have all passed, so nobody else can make Pond hold a large file in memory.
 */
export function readUpload(spec: UploadSpec): RequestHandler {
  // `inflate: false`: compressed bodies are refused, so a small request can't expand into a huge one.
  const raw = express.raw({
    type: 'application/octet-stream',
    limit: spec.maxBytes,
    inflate: false,
  })
  return (req, res, next) => {
    if (!req.is('application/octet-stream')) return sendError(res, 415, 'unsupported_content_type')
    raw(req, res, (err?: unknown) => {
      if (!err) return next()
      const kind = (err as { type?: string }).type
      if (kind === 'entity.too.large') return sendError(res, 413, 'file_too_large')
      if (kind === 'encoding.unsupported') return sendError(res, 415, 'unsupported_content_type')
      sendError(res, 400, 'upload_failed')
    })
  }
}

/** `filename*` keeps non-English names; the plain `filename` is the fallback for old clients. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** Always a download, never shown inside Pond's own pages. */
export function sendFile(res: Response, bytes: Buffer, requestedName: string): void {
  const type = detectFileType(bytes)
  res.setHeader('Content-Type', type ? mimeOf(type) : 'application/octet-stream')
  res.setHeader('Content-Disposition', contentDisposition(safeDownloadName(requestedName, type)))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  res.end(bytes)
}
