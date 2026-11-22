import { pino, type Logger } from 'pino'

/** Fields that must never reach a log line (security.md). */
export const REDACT_PATHS = [
  'password',
  'passwordHash',
  'token',
  'accessUrl',
  'setupToken',
  'access_url',
  'access_url_enc',
  'totp',
  'totpSecret',
  'ssn',
  'ein',
  'passphrase',
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessUrl',
  '*.setupToken',
  '*.ssn',
  '*.ein',
  '*.passphrase',
]

export function createLogger(level: string): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } })
}
