/**
 * Checking a pasted rclone setup (docs/backup-design.md, "M8b: detailed design").
 *
 * An allow-list: only these services and, for each, only these settings, each with a value of an
 * expected shape. Other rclone settings can run programs, read any file on the server or send
 * sign-in tokens elsewhere. The pasted text is never handed to rclone: Pond writes a new config
 * from the checked values. Messages may name a setting, never its value.
 */
import { BackupError } from '../errors.js'

export const REMOTE_TYPES = ['drive', 'dropbox', 'box', 'onedrive', 's3', 'b2'] as const
export type RemoteType = (typeof REMOTE_TYPES)[number]

export const REMOTE_NAMES: Record<RemoteType, string> = {
  drive: 'Google Drive',
  dropbox: 'Dropbox',
  box: 'Box',
  onedrive: 'OneDrive',
  s3: 'S3-compatible storage',
  b2: 'Backblaze B2',
}

export interface RemoteSetup {
  type: RemoteType
  /** In a fixed order, ready to write. Holds secrets. */
  settings: [string, string][]
}

export const MAX_SETUP_LENGTH = 32_000
const MAX_VALUE_LENGTH = 16_000

/** Returns the value to store, or null if it isn't acceptable. */
type Check = (value: string) => string | null

const matching =
  (pattern: RegExp): Check =>
  (v) =>
    pattern.test(v) ? v : null
const oneOf = (...values: string[]): Check => matching(new RegExp(`^(${values.join('|')})$`))

/** Visible ASCII without spaces: keys, ids and app secrets. */
const secret = matching(/^[!-~]{1,1024}$/)
const id = matching(/^[A-Za-z0-9_!.:-]{1,256}$/)
/** These end up inside server addresses, so nothing that could change one is allowed. */
const word = matching(/^[A-Za-z0-9-]{1,64}$/)
const bool = oneOf('true', 'false')

const token: Check = (v) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(v)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const t = parsed as Record<string, unknown>
  if (typeof t.access_token !== 'string' || !Object.values(t).every((x) => typeof x !== 'object'))
    return null
  return JSON.stringify(parsed)
}

/** Only https. rclone treats a bare host name as https, so it is written out in full. */
const endpoint: Check = (v) => {
  const full = v.includes('://') ? v : `https://${v}`
  if (!/^https:\/\/[A-Za-z0-9._~:/[\]-]{1,500}$/.test(full)) return null
  try {
    const url = new URL(full)
    return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password
      ? full
      : null
  } catch {
    return null
  }
}

const OAUTH = { client_id: secret, client_secret: secret, token }

const ALLOWED: Record<RemoteType, Record<string, Check>> = {
  drive: {
    ...OAUTH,
    scope: matching(/^(drive(\.[a-z.]+)?)(,drive(\.[a-z.]+)?)*$/),
    root_folder_id: id,
    team_drive: id,
  },
  dropbox: OAUTH,
  box: { ...OAUTH, box_sub_type: oneOf('user', 'enterprise'), root_folder_id: id },
  onedrive: {
    ...OAUTH,
    drive_id: id,
    drive_type: oneOf('personal', 'business', 'documentLibrary'),
    region: oneOf('global', 'us', 'de', 'cn'),
    tenant: matching(/^[A-Za-z0-9.-]{1,128}$/),
  },
  s3: {
    provider: word,
    access_key_id: secret,
    secret_access_key: secret,
    region: word,
    endpoint,
    location_constraint: word,
    storage_class: matching(/^[A-Z_]{1,40}$/),
    server_side_encryption: oneOf('AES256', 'aws:kms'),
    acl: oneOf('private'),
    force_path_style: bool,
    no_check_bucket: bool,
  },
  b2: { account: secret, key: secret },
}

/** Without these, rclone would go looking for other ways to sign in (or sign in as nobody). */
const REQUIRED: Record<RemoteType, string[]> = {
  drive: ['token'],
  dropbox: ['token'],
  box: ['token'],
  onedrive: ['token', 'drive_id', 'drive_type'],
  s3: ['access_key_id', 'secret_access_key'],
  b2: ['account', 'key'],
}

const refuse = (message: string) => new BackupError('bad_remote_setup', message)
/** A setting's name, safe to show back. Anything odd isn't repeated: it could be a secret. */
const shown = (key: string) => (/^[a-z][a-z0-9_]{0,40}$/.test(key) ? `"${key}"` : 'on one line')

export function parseRemoteSetup(text: string): RemoteSetup {
  if (text.length > MAX_SETUP_LENGTH) throw refuse('That setup is too long.')
  if (/RCLONE_ENCRYPT/.test(text))
    throw refuse('That setup is encrypted. Paste the output of "rclone config show" instead.')
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n/)

  let sections = 0
  const values = new Map<string, string>()
  for (const raw of lines) {
    // Line breaks and other control characters could smuggle in a second line.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B-\u001F\u007F\u0085\u2028\u2029]/.test(raw))
      throw refuse('That setup contains characters that are not allowed.')
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      const name = /^\[([^[\]]{1,100})\]$/.exec(line)?.[1]
      if (name === undefined || name === 'DEFAULT') throw refuse("That setup can't be read.")
      if (++sections > 1) throw refuse('Paste exactly one remote.')
      continue
    }
    const equals = line.indexOf('=')
    if (sections === 0 || equals < 1)
      throw refuse('Paste the whole remote, starting with its [name] line.')
    const key = line.slice(0, equals).trim()
    if (values.has(key)) throw refuse(`The setting ${shown(key)} is there twice.`)
    values.set(key, line.slice(equals + 1).trim())
  }

  const type = values.get('type') as RemoteType | undefined
  if (!type || !REMOTE_TYPES.includes(type))
    throw refuse(`Pond supports ${Object.values(REMOTE_NAMES).join(', ')}.`)
  values.delete('type')
  // Pasted S3 setups often say this. Off is the default, so it is simply dropped.
  if (values.get('env_auth') === 'false') values.delete('env_auth')

  const allowed = ALLOWED[type]
  const settings: [string, string][] = []
  for (const [key, value] of values) {
    if (!Object.hasOwn(allowed, key))
      throw refuse(`Pond doesn't accept the setting ${shown(key)} for ${REMOTE_NAMES[type]}.`)
    if (value === '') continue // rclone often writes unused settings as empty
    // rclone's config reader replaces %(name)s with another setting and strips backticks, so
    // such a value would not mean what was checked.
    const unsafe = value.length > MAX_VALUE_LENGTH || value.includes('%(') || value.startsWith('`')
    const checked = unsafe || value.startsWith('"""') ? null : allowed[key]!(value)
    if (checked === null || checked.includes('%('))
      throw refuse(`The setting ${shown(key)} doesn't have a value Pond accepts.`)
    settings.push([key, checked])
  }
  const have = new Set(settings.map(([k]) => k))
  const missing = REQUIRED[type].filter((k) => !have.has(k))
  if (missing.length)
    throw refuse(`That setup is missing ${missing.map((k) => `"${k}"`).join(' and ')}.`)

  const order = Object.keys(allowed)
  settings.sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
  return { type, settings }
}

/** The only config rclone ever sees. The remote is always called `pond`. */
export const writeRemoteConfig = (setup: RemoteSetup): string =>
  `[pond]\ntype = ${setup.type}\n${setup.settings.map(([k, v]) => `${k} = ${v}\n`).join('')}`

const FOLDER_PART = /^[A-Za-z0-9_.](?:[A-Za-z0-9 _.-]{0,98}[A-Za-z0-9_.-])?$/

/** The folder on the remote. For S3 and B2 its first part is the bucket. */
export function checkRemoteFolder(folder: string): string {
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, '')
  const parts = trimmed.split('/')
  const ok =
    trimmed.length <= 300 &&
    parts.every((p) => FOLDER_PART.test(p) && p !== '.' && !p.includes('..'))
  if (!ok)
    throw new BackupError(
      'bad_remote_folder',
      'Use a folder name made of letters, numbers, spaces, "_", "-", "." and "/".',
    )
  return trimmed
}
