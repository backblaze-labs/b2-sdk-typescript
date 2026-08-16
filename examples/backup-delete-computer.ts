/**
 * Delete a Computer Backup record.
 *
 * Usage:
 *   B2_CONFIRM_DELETE_COMPUTER=1 B2_MASTER_KEY_ID=xxx B2_MASTER_KEY=yyy npx tsx examples/backup-delete-computer.ts <computer-id> [account-id]
 */

import { accountId, computerId } from '@backblaze-labs/b2-sdk/backup'
import { backupClientFromEnv } from './_shared/backup.ts'
import { fail, formatTimestamp, requireConfirmation } from './_shared/env.ts'

async function main() {
  const rawComputerId = process.argv[2]
  const rawAccountId = process.argv[3]?.trim() || undefined

  if (rawComputerId === undefined) {
    fail(
      'Usage: B2_CONFIRM_DELETE_COMPUTER=1 npx tsx examples/backup-delete-computer.ts <computer-id> [account-id]',
    )
  }
  requireConfirmation(
    'B2_CONFIRM_DELETE_COMPUTER',
    'Deleting a Computer Backup record is permanent.',
  )

  const backup = backupClientFromEnv()
  await backup.authorize()

  const deleted = await backup.deleteComputer({
    computerId: computerId(rawComputerId),
    ...(rawAccountId !== undefined ? { accountId: accountId(rawAccountId) } : {}),
  })

  for (const computer of deleted) {
    console.log(`Deleted: ${computer.computerName} (${computer.computerId})`)
    console.log(`Last uploaded file: ${formatTimestamp(computer.lastFileUploadedTimestamp)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
