import { SimpleFinError } from './types.js'

/** Setup Token -> claim URL: the token is Base64 text that decodes to a URL. */
export function decodeSetupToken(token: string): string {
  const cleaned = token.trim().replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned) || cleaned.length < 8) {
    throw new SimpleFinError('invalid_token', 'That does not look like a SimpleFIN Setup Token.')
  }
  const text = Buffer.from(cleaned.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  return assertSafeUrl(text.trim()).toString()
}

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
]

/**
 * We make server-side requests to URLs a user pasted in, so only public https addresses are
 * allowed (an admin could otherwise point Pond at things inside the home network). Port 443
 * only; no localhost, private or link-local addresses. Redirects are also refused by the client.
 */
export function assertSafeUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SimpleFinError('invalid_token', 'That does not contain a valid URL.')
  }
  const host = url.hostname.toLowerCase()
  const bad =
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    PRIVATE_V4.some((re) => re.test(host)) ||
    host === '[::1]' ||
    /^\[(fc|fd|fe[89ab])/i.test(host) ||
    !host.includes('.')
  if (bad)
    throw new SimpleFinError('unsafe_url', 'Only public https SimpleFIN addresses are allowed.')
  return url
}

/** Access URL -> the request base (credentials removed) and the Basic auth header value. */
export function splitAccessUrl(accessUrl: string): { base: string; authorization: string } {
  const url = assertSafeUrl(accessUrl)
  if (!url.username) throw new SimpleFinError('bad_response', 'The Access URL has no credentials.')
  const user = decodeURIComponent(url.username)
  const pass = decodeURIComponent(url.password)
  const authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  url.username = ''
  url.password = ''
  return { base: url.toString().replace(/\/$/, ''), authorization }
}
