/**
 * Serves the built web app in production (docs/ship-design.md, M9a). In development Vite does
 * this instead. These are public files with no household data, so there is no sign-in here;
 * everything under /api is handled, and answered, before a request can reach this.
 */
import fs from 'node:fs'
import path from 'node:path'
import express, { Router } from 'express'

/** Vite puts a hash of the contents in the name of everything here, so a file never changes. */
const HASHED_FOLDER = 'assets'

const FOREVER = 'public, max-age=31536000, immutable'
/** Ask Pond each time, so an update shows up at once. */
const CHECK_EVERY_TIME = 'no-cache'

export function webRouter(webDir: string): Router {
  const root = path.resolve(webDir)
  // Better to stop at startup than to run with no pages.
  if (!fs.existsSync(path.join(root, 'index.html')))
    throw new Error(`There is no built web app at ${root}. Check POND_WEB_DIR.`)
  const hashed = path.join(root, HASHED_FOLDER) + path.sep

  const r = Router()
  r.use(
    express.static(root, {
      index: false,
      redirect: false,
      cacheControl: false,
      setHeaders: (res, file) => {
        res.setHeader('Cache-Control', file.startsWith(hashed) ? FOREVER : CHECK_EVERY_TIME)
      },
    }),
  )

  // Page addresses such as /settings are drawn by the web app, so they all get index.html.
  // A missing file is a 404: after an update, an open tab may ask for a file that is gone, and
  // answering with a page would fail in a far more confusing way.
  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const parts = req.path.split('/')
    if (parts[1] === HASHED_FOLDER || parts.at(-1)?.includes('.')) return next()
    res.setHeader('Cache-Control', CHECK_EVERY_TIME)
    res.sendFile('index.html', { root, cacheControl: false }, (err) => {
      if (err) next(err)
    })
  })
  return r
}
