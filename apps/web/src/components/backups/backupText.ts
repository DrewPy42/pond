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
}

export function warningText(w: BackupWarning): string {
  if (w.kind === 'no_destination')
    return "Scheduled backups are on, but there's nowhere to save them. Turn on the backup folder, or turn off automatic backups."
  if (w.kind === 'failed')
    return `The scheduled backup to the backup folder on ${when(w.at)} failed. ${REASONS[w.reason] ?? 'Try backing up by hand to check.'}`
  return w.lastSuccessAt
    ? `Your newest backup in the backup folder is from ${when(w.lastSuccessAt)}.`
    : 'Scheduled backups are on, but none has reached the backup folder yet.'
}
