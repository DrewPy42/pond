import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig(env): secure cookies', () => {
  /**
   * Inputs:   NODE_ENV=production, alone and with POND_COOKIE_SECURE=false
   * Expected: Secure cookies both times: nothing can turn them off in production
   */
  it('always uses Secure cookies in production', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).cookieSecure).toBe(true)
    const asked = loadConfig({ NODE_ENV: 'production', POND_COOKIE_SECURE: 'false' })
    expect(asked.cookieSecure).toBe(true)
  })

  /**
   * Inputs:   development, with no setting, "false" and "true"
   * Expected: off, off and on, so plain-HTTP development works and can still be tried Secure
   */
  it('leaves development to the setting', () => {
    expect(loadConfig({}).cookieSecure).toBe(false)
    expect(loadConfig({ POND_COOKIE_SECURE: 'false' }).cookieSecure).toBe(false)
    expect(loadConfig({ POND_COOKIE_SECURE: 'true' }).cookieSecure).toBe(true)
  })
})

describe('loadConfig(env): HSTS and time zone', () => {
  /**
   * Inputs:   no POND_HSTS, "false" and "true"
   * Expected: on only for "true"
   */
  it('keeps HSTS off unless turned on', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).hsts).toBe(false)
    expect(loadConfig({ POND_HSTS: 'false' }).hsts).toBe(false)
    expect(loadConfig({ POND_HSTS: 'true' }).hsts).toBe(true)
  })

  /**
   * Inputs:   "America/Chicago", then "Central" and an empty value
   * Expected: the first is used; the others stop Pond at startup, because a wrong zone would
   *           quietly shift bank dates and backup times
   */
  it('refuses a time zone that does not exist', () => {
    expect(loadConfig({ POND_TIMEZONE: 'America/Chicago' }).timeZone).toBe('America/Chicago')
    expect(() => loadConfig({ POND_TIMEZONE: 'Central' })).toThrow(/time zone/)
    expect(() => loadConfig({ POND_TIMEZONE: '' })).toThrow(/time zone/)
  })
})
