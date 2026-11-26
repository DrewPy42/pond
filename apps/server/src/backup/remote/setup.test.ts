/** parseRemoteSetup(text), writeRemoteConfig(setup) and checkRemoteFolder(folder). */
import { describe, expect, it } from 'vitest'
import { checkRemoteFolder, parseRemoteSetup, writeRemoteConfig } from './setup.js'

const TOKEN =
  '{"access_token":"ya29.SECRET","token_type":"Bearer","refresh_token":"1//SECRET","expiry":"2026-01-01T00:00:00Z"}'
const drive = (...extra: string[]) =>
  ['[mydrive]', 'type = drive', 'scope = drive.file', `token = ${TOKEN}`, ...extra].join('\n')
const s3 = (...extra: string[]) =>
  [
    '[backup]',
    'type = s3',
    'provider = AWS',
    'access_key_id = AKIAEXAMPLE',
    'secret_access_key = wJalr/XUtnFEMI+SECRET',
    ...extra,
  ].join('\n')

const refusal = (text: string): string => {
  try {
    parseRemoteSetup(text)
  } catch (e) {
    expect(e).toMatchObject({ code: 'bad_remote_setup' })
    return (e as Error).message
  }
  throw new Error(`accepted: ${text}`)
}

describe('parseRemoteSetup(text)', () => {
  /**
   * Inputs:   a pasted setup for each supported service, with Windows line endings, comments,
   *           empty settings and "env_auth = false" where rclone commonly writes them
   * Expected: accepted, with empty and harmless settings dropped and the remote renamed "pond"
   */
  it('accepts a normal setup for each service', () => {
    const setups = [
      drive('team_drive = '),
      `[d]\r\ntype = dropbox\r\n# note\r\ntoken = ${TOKEN}\r\n`,
      `[b]\ntype = box\nbox_sub_type = user\ntoken = ${TOKEN}`,
      `[o]\ntype = onedrive\ntoken = ${TOKEN}\ndrive_id = b!Abc_12-3\ndrive_type = personal`,
      s3('env_auth = false', 'endpoint = https://minio.lan:9000', 'force_path_style = true'),
      '[bb]\ntype = b2\naccount = 0012ab\nkey = K001abc/def+g',
    ]
    for (const text of setups) {
      const written = writeRemoteConfig(parseRemoteSetup(text))
      expect(written.startsWith('[pond]\ntype = ')).toBe(true)
      expect(written).not.toMatch(/env_auth|team_drive|#/)
      // What Pond writes, it accepts again unchanged.
      expect(writeRemoteConfig(parseRemoteSetup(written))).toBe(written)
    }
  })

  /**
   * Inputs:   each setting that can run a program, read a file on the server, redirect sign-in
   *           or reach for other credentials
   * Expected: refused, naming the setting and never repeating its value
   */
  it.each([
    ['env_auth', 'true'],
    ['shared_credentials_file', '/etc/passwd'],
    ['profile', 'evil'],
    ['sts_endpoint', 'https://evil.example'],
    ['ibm_iam_endpoint', 'https://evil.example'],
    ['download_url', 'https://evil.example'],
    ['role_arn', 'arn:aws:iam::1:role/x'],
    ['bearer_token_command', 'rm -rf /'],
    ['ssh', 'sh -c true'],
  ])('refuses the S3 setting %s', (key, value) => {
    const message = refusal(s3(`${key} = ${value}`))
    expect(message).toContain(`"${key}"`)
    expect(message).not.toContain(value)
  })

  it.each([
    'service_account_file',
    'service_account_credentials',
    'auth_url',
    'token_url',
    'client_credentials',
    'impersonate',
    'env_auth',
  ])('refuses the Google Drive setting %s', (key) => {
    expect(refusal(drive(`${key} = true`))).toContain(`"${key}"`)
  })

  /**
   * Inputs:   services that reach the server's own files or wrap another remote, two remotes, a
   *           DEFAULT section, an encrypted config, a line with no section, a repeated setting
   * Expected: all refused
   */
  it('refuses other services, extra sections and encrypted configs', () => {
    for (const type of ['local', 'alias', 'crypt', 'union', 'sftp', 'webdav', 'http', ''])
      refusal(`[x]\ntype = ${type}\nremote = /`)
    refusal(`${drive()}\n[second]\ntype = local`)
    refusal(`[DEFAULT]\ntoken_url = https://evil.example\n${drive()}`)
    refusal('# Encrypted rclone configuration File\n\nRCLONE_ENCRYPT_V0:\nabc=')
    refusal(`type = drive\ntoken = ${TOKEN}`)
    refusal(drive('scope = drive'))
  })

  /**
   * Inputs:   values using rclone's %(name)s substitution and backtick quoting, hidden line
   *           breaks, and characters that would change a server address
   * Expected: refused, so a checked value always means what it says
   */
  it('refuses values that rclone or a server address would read differently', () => {
    refusal(s3('region = a%(secret_access_key)sb'))
    refusal(s3('region = `us-east-1`'))
    refusal(s3('region = """us"""'))
    for (const hidden of ['\r', ' ', '\u0085', '\u0000'])
      refusal(s3(`region = us${hidden}env_auth = true`))
    for (const region of ['evil.example/', 'x.evil.example', 'us#x', 'a b'])
      refusal(s3(`region = ${region}`))
    refusal(
      `[o]\ntype = onedrive\ntoken = ${TOKEN}\ndrive_id = a\ndrive_type = personal\ntenant = x/../y`,
    )
    refusal(s3('acl = public-read'))
  })

  /**
   * Inputs:   "%(" in fields that otherwise allow any visible character (an app secret, a B2
   *           key), and in a token written as the JSON escape for "%", which only becomes "%("
   *           when Pond rewrites the token
   * Expected: all refused; rclone would replace it with another setting's value
   */
  it("refuses rclone's substitution wherever it could end up", () => {
    refusal(s3().replace('wJalr/XUtnFEMI+SECRET', 'a%(access_key_id)sb'))
    refusal('[b]\ntype = b2\naccount = a\nkey = x%(account)s')
    refusal(drive('client_secret = %(scope)s'))
    refusal('[d]\ntype = dropbox\ntoken = {"access_token":"\\u0025(token)s"}')
  })

  /**
   * Inputs:   S3 server addresses
   * Expected: https (also when written as a bare host, which rclone reads as https), including
   *           home-network ones; never http, a login in the address, a query or another scheme
   */
  it('allows only https server addresses', () => {
    const stored = (value: string) =>
      new Map(parseRemoteSetup(s3(`endpoint = ${value}`)).settings).get('endpoint')
    expect(stored('s3.us-west-1.wasabisys.com')).toBe('https://s3.us-west-1.wasabisys.com')
    expect(stored('https://192.168.1.20:9000')).toBe('https://192.168.1.20:9000')
    for (const bad of [
      'http://nas.lan:9000',
      'file:///etc',
      'https://user:pass@host',
      'https://host?x=1',
      'https://',
    ])
      refusal(s3(`endpoint = ${bad}`))
  })

  /**
   * Inputs:   setups missing what each service needs, a token that isn't a token, a long paste
   * Expected: refused; without these rclone would look for other ways to sign in
   */
  it('requires the sign-in settings', () => {
    expect(refusal('[d]\ntype = drive\nscope = drive')).toContain('"token"')
    expect(refusal('[s]\ntype = s3\nprovider = AWS')).toContain('"access_key_id"')
    for (const token of ['abc', '[]', '{}', '{"access_token":{"a":1}}'])
      refusal(`[d]\ntype = dropbox\ntoken = ${token}`)
    refusal(`${drive()}\n#${'x'.repeat(40_000)}`)
  })

  /**
   * Inputs:   a pasted line whose "setting name" is really a secret
   * Expected: the message doesn't repeat it
   */
  it("doesn't echo anything that might be a secret", () => {
    expect(refusal(drive('1//SECRET-value=abc'))).not.toContain('SECRET')
    expect(refusal(s3('region = my secret value'))).not.toContain('my secret value')
  })
})

describe('checkRemoteFolder(folder)', () => {
  /**
   * Inputs:   ordinary folders, then ones that climb out, look like an option or choose another
   *           remote
   * Expected: the first are trimmed and kept; the rest are refused
   */
  it('accepts plain folder names only', () => {
    expect(checkRemoteFolder(' /my-bucket/Pond backups/ ')).toBe('my-bucket/Pond backups')
    expect(checkRemoteFolder('Pond')).toBe('Pond')
    for (const bad of [
      '',
      '/',
      '..',
      'a/../b',
      'a/..hidden',
      'a//b',
      '-flag',
      'a/-flag',
      ':local:/etc',
      'other:path',
      'a,b=c',
      'a\nb',
      'a\\b',
      ' a / b',
    ])
      expect(() => checkRemoteFolder(bad), bad).toThrow()
  })
})
