import type { BackupWarning } from '@pond/shared'

export const when = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Never'

const REASONS: Record<string, string> = {
  folder_marker_missing: "The backup folder's drive or share doesn't seem to be connected.",
  folder_not_available: "The backup folder isn't available.",
  not_enough_space: "There wasn't enough free space.",
  key_mismatch: "Pond's saved secrets didn't pass the check.",
  damaged_backup: "The backup didn't pass its check.",
  remote_sign_in_failed: 'The storage service refused the sign-in. Paste a new setup.',
  remote_unreachable: "Pond couldn't reach the storage service.",
  remote_full: 'The storage service has no room left.',
  remote_failed: 'The storage service reported a problem.',
  remote_upload_unconfirmed: "The storage service didn't confirm the upload.",
  remote_not_available: "This Pond doesn't have rclone.",
}

const PLACE = { folder: 'the backup folder', remote: 'online storage' } as const

export function warningText(w: BackupWarning): string {
  if (w.kind === 'paused')
    return 'Backups to online storage are paused after a restore, until an admin turns them back on.'
  if (w.kind === 'failed')
    return `The scheduled backup to ${PLACE[w.destination]} on ${when(w.at)} failed. ${REASONS[w.reason] ?? 'Try backing up by hand to check.'}`
  return w.lastSuccessAt
    ? `Your newest backup in ${PLACE[w.destination]} is from ${when(w.lastSuccessAt)}.`
    : `Scheduled backups are on, but none has reached ${PLACE[w.destination]} yet.`
}
