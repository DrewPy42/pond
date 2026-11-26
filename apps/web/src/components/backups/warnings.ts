import type { BackupWarning } from '@pond/shared'
import { ref } from 'vue'

/** One list for the banner and the Backups screen, so fixing a problem clears both at once. */
export const backupWarnings = ref<BackupWarning[]>([])
