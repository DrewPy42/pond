import { BackupError } from './errors.js'

/** One backup or restore step at a time. After a restore is confirmed, nothing else starts. */
export class BackupLock {
  private held = false
  restorePending = false

  acquire(): () => void {
    if (this.restorePending)
      throw new BackupError('restore_pending', 'A restore is waiting for Pond to restart.')
    if (this.held) throw new BackupError('busy', 'A backup or restore is already running.')
    this.held = true
    return () => void (this.held = false)
  }
}
