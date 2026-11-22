import { Writable } from 'node:stream'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { REDACT_PATHS } from './logger'

describe('createLogger / REDACT_PATHS: secret redaction', () => {
  /**
   * Function: pino logger configured with REDACT_PATHS
   * Inputs:   a log line containing password "hunter2", a nested accessUrl "https://u:p@x" and
   *           an ssn "123-45-6789"
   * Expected: none of those three values appear in the output (CLAUDE.md rule 7)
   */
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
