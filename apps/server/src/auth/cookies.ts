import type { CookieOptions, Response } from 'express'
import { CSRF_COOKIE, SESSION_COOKIE } from '../http.js'
import type { NewSession } from './sessions.js'

export function setSessionCookies(res: Response, s: NewSession, secure: boolean): void {
  const base: CookieOptions = { sameSite: 'strict', secure, path: '/', expires: s.expiresAt }
  res.cookie(SESSION_COOKIE, s.token, { ...base, httpOnly: true })
  // Readable by the web app so it can echo it in the x-csrf-token header.
  res.cookie(CSRF_COOKIE, s.csrfToken, { ...base, httpOnly: false })
}

export function clearSessionCookies(res: Response, secure: boolean): void {
  const opts: CookieOptions = { sameSite: 'strict', secure, path: '/' }
  res.clearCookie(SESSION_COOKIE, { ...opts, httpOnly: true })
  res.clearCookie(CSRF_COOKIE, opts)
}
