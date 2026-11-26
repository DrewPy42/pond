/** An expected backup or restore failure. `code` is safe to return to the client and to audit. */
export class BackupError extends Error {
  constructor(
    public code: BackupErrorCode,
    /** A plain sentence for the admin. Never contains a passphrase, key or file contents. */
    public detail?: string,
  ) {
    super(detail ?? code)
  }
}

export type BackupErrorCode =
  | 'passphrase_not_set'
  | 'weak_passphrase'
  | 'busy'
  | 'restore_pending'
  | 'folder_not_available'
  | 'folder_marker_missing'
  | 'destination_required'
  | 'bad_remote_setup'
  | 'bad_remote_folder'
  | 'remote_not_available'
  | 'remote_not_set_up'
  | 'remote_paused'
  | 'remote_sign_in_failed'
  | 'remote_unreachable'
  | 'remote_full'
  | 'remote_failed'
  | 'remote_upload_unconfirmed'
  | 'not_enough_space'
  | 'too_large'
  | 'upload_failed'
  | 'wrong_passphrase'
  | 'not_a_backup'
  | 'damaged_backup'
  | 'newer_backup'
  | 'key_mismatch'
  | 'restore_expired'
  | 'safety_copy_failed'
  | 'backup_failed'

export const isNoSpace = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOSPC'
