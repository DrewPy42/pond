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

/** Same-origin JSON fetch. Sends the CSRF token on state-changing requests. */
export async function api<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const csrf = csrfToken()
  if (csrf && method !== 'GET') headers['x-csrf-token'] = decodeURIComponent(csrf)
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
  not_found: "That wasn't found.",
}
export const errorMessage = (e: unknown): string =>
  e instanceof ApiError
    ? (MESSAGES[e.code] ?? `Something went wrong (${e.code}).`)
    : "Can't reach the Pond server."
