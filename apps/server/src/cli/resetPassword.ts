/**
 * Password recovery, run on the machine itself: access to it is the root of trust
 * (security.md). No web route reaches this.
 */
import { randomBytes } from 'node:crypto'
import { recordAudit } from '../audit.js'
import { hashPassword } from '../auth/password.js'
import { revokeUserSessions } from '../auth/sessions.js'
import type { Repos } from '../repos/types.js'

export interface ResetResult {
  temporaryPassword: string
  isAdmin: boolean
  disabled: boolean
  removedTwoFactor: boolean
}

/** Returns null if there is no such user. */
export async function resetPassword(
  d: { repos: Repos; now: () => Date; newId: () => string },
  o: { username: string; removeTwoFactor: boolean },
): Promise<ResetResult | null> {
  const user = d.repos.users.findByUsername(o.username.trim().toLowerCase())
  if (!user) return null
  const temporaryPassword = randomBytes(15).toString('base64url')
  const passwordHash = await hashPassword(temporaryPassword)
  d.repos.transaction(() => {
    d.repos.users.update(user.id, {
      passwordHash,
      ...(o.removeTwoFactor ? { totpSecretEnc: null, totpEnabledAt: null } : {}),
    })
    if (o.removeTwoFactor) d.repos.recoveryCodes.replaceForUser(user.id, [])
    revokeUserSessions(d.repos.sessions, user.id)
    recordAudit(
      d.repos.audit,
      {
        actorType: 'system',
        action: 'auth.password_reset_from_console',
        targetType: 'user',
        targetId: user.id,
        meta: { removedTwoFactor: o.removeTwoFactor },
      },
      d.now(),
      d.newId,
    )
  })
  return {
    temporaryPassword,
    isAdmin: user.isAdmin,
    disabled: user.status !== 'active',
    removedTwoFactor: o.removeTwoFactor,
  }
}
