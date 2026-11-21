import { Writable } from 'node:stream'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { REDACT_PATHS } from './logger'

describe('logger redaction', () => {
  it('redacts secrets', () => {
    let out = ''
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString()
        cb()
      },
    })
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink)
    log.info({ password: 'hunter2', conn: { accessUrl: 'https://u:p@x' }, ssn: '123-45-6789' }, 'x')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('u:p@x')
    expect(out).not.toContain('123-45-6789')
  })
})
