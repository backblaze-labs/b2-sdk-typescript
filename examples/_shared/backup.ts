import { BackupClient } from '@backblaze-labs/b2-sdk/backup'
import { masterKeyOptions } from './env.ts'

export function backupClientFromEnv(): BackupClient {
  return new BackupClient(masterKeyOptions())
}
