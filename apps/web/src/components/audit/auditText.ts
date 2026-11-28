/**
 * Plain words for the audit log. Only the details named here are shown: nothing else in an
 * entry reaches the screen. An action with no words yet is shown by its code, never hidden.
 */
import type { AuditEntryView } from '@pond/shared'

/** Names for the ids in entries. Anything since removed is simply missing. */
export interface AuditNames {
  users: Map<string, string>
  spaces: Map<string, string>
  apps: Map<string, string>
}

export const ACTIONS: Record<string, string> = {
  'setup.admin_created': 'Set up Pond',
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.lockout': 'Too many failed tries, so Pond made them wait',
  'auth.recovery_code_used': 'Used a recovery code to sign in',
  'auth.totp_enabled': 'Turned on two-step sign-in',
  'auth.password_changed': 'Changed their password',
  'auth.password_reset_from_console': 'Password reset',
  'user.created': 'Added a user',
  'user.updated': "Changed a user's details",
  'user.role_changed': 'Changed who is an administrator',
  'user.disabled': 'Turned off an account',
  'user.enabled': 'Turned an account back on',
  'space.created': 'Created a Space',
  'space.updated': 'Changed a Space',
  'space.archived': 'Archived a Space',
  'space.restored': 'Brought back an archived Space',
  'space.deleted': 'Deleted a Space',
  'space.member_added': 'Added someone to a Space',
  'space.member_role_changed': "Changed someone's role in a Space",
  'space.member_removed': 'Removed someone from a Space',
  'connection.created': 'Connected a bank',
  'connection.account_assigned': 'Put a bank account in a Space',
  'connection.revoked': 'Disconnected a bank',
  'import.committed': 'Imported transactions from a file',
  'backup.created': 'Made a backup',
  'backup.failed': 'A backup failed',
  'backup.downloaded': 'Downloaded a backup',
  'backup.settings_changed': 'Changed backup settings',
  'backup.restored': 'Restored Pond from a backup',
  'backup.restore_failed': "A restore didn't work",
  'lilypad.installed': 'Installed an app',
  'lilypad.updated': 'Updated an app',
  'lilypad.uninstalled': 'Removed an app',
  'lilypad.enabled': 'Turned on an app in a Space',
  'lilypad.disabled': 'Turned off an app in a Space',
  'lilypad.reauth_access': 'Opened private information in an app',
  'lilypad.auto_disabled': 'Pond switched off an app after repeated errors',
}

/** What the apps that come with Pond record, after `lilypad.<app>.` */
export const APP_ACTIONS: Record<string, string> = {
  'budget.changed': 'Changed a budget',
  'goal.created': 'Created a savings goal',
  'goal.deleted': 'Deleted a savings goal',
  'profile.changed': 'Changed the business profile',
  'deduction.changed': 'Changed a deduction',
  'person.added': 'Added a person',
  'person.changed': "Changed a person's details",
  'person.deleted': 'Deleted a person',
  'pay.added': 'Added a pay record',
  'pay.removed': 'Removed a pay record',
  'taxid.revealed': 'Viewed a full tax ID',
  'document.added': 'Added a document',
  'document.downloaded': 'Downloaded a document',
  'document.deleted': 'Deleted a document',
  'note.created': 'Added a note',
}

export interface AuditLine {
  what: string
  who: string
  /** Extra facts, such as which Space. May be empty. */
  details: string
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const user = (names: AuditNames, id: string | null) =>
  (id && names.users.get(id)) || 'a removed user'

const appName = (names: AuditNames, id: string | null) =>
  (id && names.apps.get(id)) || id || 'an app'

const PLACES: Record<string, string> = {
  folder: 'to the backup folder',
  download: 'as a download',
  remote: 'to online storage', // entries from before it was removed
}

function split(action: string): { app: string; rest: string } | null {
  const m = /^lilypad\.([^.]+)\.(.+)$/.exec(action)
  return m ? { app: m[1]!, rest: m[2]! } : null
}

function who(e: AuditEntryView, names: AuditNames): string {
  if (e.action === 'auth.password_reset_from_console') return 'From the computer running Pond'
  if (e.actorType === 'user' && e.actorId) return names.users.get(e.actorId) ?? 'A removed user'
  // An app records its own actions under its own name, not the person using it.
  if (e.actorType === 'lilypad') return appName(names, e.actorId)
  if (e.action === 'auth.login_failed' || e.action === 'auth.lockout') return 'Not signed in'
  return 'Pond'
}

function details(e: AuditEntryView, names: AuditNames): string {
  const meta = e.meta ?? {}
  const out: string[] = []
  const ip = text(meta.ip)
  switch (e.action) {
    case 'auth.login':
      break
    case 'auth.login_failed':
    case 'auth.lockout':
      // What was typed as a username is never shown unless it is a real account: someone
      // may have typed a password there by mistake.
      if (meta.scope === 'setup_restore') out.push('restoring during first-time setup')
      else if (e.targetId) out.push(`for ${user(names, e.targetId)}`)
      else if (e.action === 'auth.login_failed') out.push("for a username that doesn't exist")
      break
    case 'auth.password_reset_from_console':
      out.push(`for ${user(names, e.targetId)}`)
      if (meta.removedTwoFactor === true) out.push('two-step sign-in turned off')
      break
    case 'user.created':
    case 'user.updated':
    case 'user.disabled':
    case 'user.enabled':
      out.push(user(names, e.targetId))
      if (meta.isAdmin === true) out.push('an administrator')
      break
    case 'user.role_changed':
      out.push(user(names, e.targetId))
      if (typeof meta.isAdmin === 'boolean')
        out.push(meta.isAdmin ? 'now an administrator' : 'no longer an administrator')
      break
    case 'space.member_added':
    case 'space.member_role_changed':
    case 'space.member_removed':
      if (e.targetType === 'user') out.push(user(names, e.targetId))
      if (text(meta.role)) out.push(`as ${text(meta.role)}`)
      break
    case 'connection.created':
    case 'connection.revoked':
      if (text(meta.label)) out.push(text(meta.label))
      break
    case 'import.committed':
      if (text(meta.filename)) out.push(text(meta.filename))
      if (typeof meta.imported === 'number') out.push(`${meta.imported} imported`)
      break
    case 'backup.created':
    case 'backup.failed':
      if (PLACES[text(meta.destination)]) out.push(PLACES[text(meta.destination)]!)
      if (meta.trigger === 'schedule') out.push('on schedule')
      break
    case 'backup.restored':
    case 'backup.restore_failed':
      if (text(meta.requestedBy)) out.push(`asked for by ${text(meta.requestedBy)}`)
      break
    default:
      if (e.targetType === 'lilypad') out.push(appName(names, e.targetId))
      if (e.action === 'lilypad.uninstalled' && meta.deletedData === true)
        out.push('and deleted its information')
  }
  if (e.spaceId) out.push(`Space: ${names.spaces.get(e.spaceId) ?? 'one that was deleted'}`)
  if (ip) out.push(`from ${ip}`)
  return out.join(' · ')
}

export function auditLine(e: AuditEntryView, names: AuditNames): AuditLine {
  const app = split(e.action)
  const what = (app ? APP_ACTIONS[app.rest] : ACTIONS[e.action]) ?? e.action
  return { what, who: who(e, names), details: details(e, names) }
}
