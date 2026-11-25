/** Small pure helpers behind what pads can do in the web app. */

export type SpaceRole = 'viewer' | 'editor' | 'owner'
const RANK: Record<SpaceRole, number> = { viewer: 1, editor: 2, owner: 3 }

/** Whether to show a pad's link or page. Tidiness only: the server enforces access. */
export const roleAllows = (needed: SpaceRole | undefined, mine: SpaceRole | undefined): boolean =>
  !needed || (!!mine && RANK[mine] >= RANK[needed])

/** The filename a download response asks for. */
export function filenameFrom(disposition: string | null): string {
  if (!disposition) return 'download'
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      /* fall through to the plain name */
    }
  }
  return /filename="([^"]*)"/i.exec(disposition)?.[1] || 'download'
}

const needsPassword = (e: unknown): boolean => (e as { code?: string })?.code === 'reauth_required'

/**
 * Runs a request; if the server wants the password again, asks the person and tries once more.
 * If they cancel, the original refusal is passed on.
 */
export async function withReauth<T>(
  request: () => Promise<T>,
  askForPassword: () => Promise<boolean>,
): Promise<T> {
  try {
    return await request()
  } catch (e) {
    if (!needsPassword(e) || !(await askForPassword())) throw e
    return request()
  }
}
