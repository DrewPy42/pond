import { filenameFrom } from './composables/padFiles'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

function csrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith('pond_csrf='))
    ?.slice('pond_csrf='.length)
}

function csrfHeaders(method: string): Record<string, string> {
  const csrf = csrfToken()
  return csrf && method !== 'GET' ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}
}

async function failure(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return new ApiError(res.status, String(data.error ?? 'error'), data)
}

/** Sends a file as the raw request body (LilyPad upload routes). */
export async function apiUpload<T = Record<string, unknown>>(path: string, file: Blob): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...csrfHeaders('POST') },
    credentials: 'same-origin',
    body: file,
  })
  if (!res.ok) throw await failure(res)
  return (await res.json().catch(() => ({}))) as T
}

/** Fetches a file and hands it to the browser to save. */
export async function apiDownload(path: string): Promise<void> {
  const res = await fetch(path, { credentials: 'same-origin' })
  if (!res.ok) throw await failure(res)
  const url = URL.createObjectURL(await res.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = filenameFrom(res.headers.get('Content-Disposition'))
  link.click()
  // Freed a little later: some browsers start the save after this function returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Same-origin JSON fetch. Sends the CSRF token on state-changing requests. */
export async function api<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers = csrfHeaders(method)
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? 'error'), data)
  return data as T
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Wrong username, password or code.',
  too_many_attempts: 'Too many attempts. Wait a bit and try again.',
  invalid_setup_code: "That setup code isn't right. Check the server console.",
  weak_password: 'Choose a longer, less common password (at least 12 characters).',
  invalid_code: "That code didn't match. Check your authenticator app and try again.",
  invalid_input: 'Please check the highlighted fields.',
  username_taken: 'That username is taken.',
  splits_do_not_balance:
    "The splits don't add up to the total. Adjust them so nothing is left over.",
  splits_required:
    'This transaction has several splits, so enter the splits again for the new amount.',
  linked_transfer: 'This is part of a linked transfer. Unlink it before changing the amount.',
  not_manual: 'Only transactions you entered by hand can be deleted.',
  forbidden_space: "You can't put money into a Space where you can't edit.",
  invalid_category: 'Pick a category from the same Space as the split.',
  already_linked: 'One of those transactions is already linked as a transfer.',
  cannot_link:
    "Those two transactions can't be linked: a transfer needs equal and opposite amounts on two different accounts in the same currency.",
  forbidden: "You don't have permission to do that.",
  has_transactions:
    "This account already has transactions, so it can't be moved to another Space yet.",
  sync_too_soon: 'That account was synced a moment ago. Wait a few minutes before syncing again.',
  revoked: 'That connection has been disconnected.',
  synced_account: "This account is filled in by your bank, so transactions can't be added by hand.",
  not_found: "That wasn't found.",
  reauth_required: 'Enter your password to see this.',
  file_too_large: 'That file is too big.',
  file_required: 'Choose a file first.',
  unsupported_file_type: "That kind of file isn't accepted here.",
  file_not_saved: "Pond couldn't save the file. Check that the disk has room.",
  file_unreadable: "Pond couldn't open that file.",
}
export const errorMessage = (e: unknown): string => {
  if (!(e instanceof ApiError)) return "Can't reach the Pond server."
  // Some errors (such as SimpleFIN's) carry a sanitized, human-readable message from the server.
  const fromServer = typeof e.body.message === 'string' ? e.body.message : ''
  return MESSAGES[e.code] ?? (fromServer || `Something went wrong (${e.code}).`)
}
