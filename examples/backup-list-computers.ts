/**
 * List Computer Backup records with SDK pagination.
 *
 * Usage:
 *   B2_MASTER_KEY_ID=xxx B2_MASTER_KEY=yyy npx tsx examples/backup-list-computers.ts [account-id]
 */

import { accountId } from '@backblaze-labs/b2-sdk/backup'
import {
  backupClientFromEnv,
  formatTimestamp,
  optionalEnv,
  optionalPositiveInteger,
} from './_partner/env.ts'

async function main() {
  const rawAccountId = process.argv[2]?.trim() || undefined
  const pageSize = optionalPositiveInteger(
    optionalEnv('B2_COMPUTER_PAGE_SIZE'),
    'B2_COMPUTER_PAGE_SIZE',
    100,
  )
  const maxComputers = optionalPositiveInteger(
    optionalEnv('B2_MAX_COMPUTERS'),
    'B2_MAX_COMPUTERS',
    100,
  )

  const backup = backupClientFromEnv()
  await backup.authorize()

  let seen = 0
  for await (const computer of backup.paginateComputers({
    ...(rawAccountId !== undefined ? { accountId: accountId(rawAccountId) } : {}),
    pageSize,
  })) {
    seen += 1
    console.log(`${computer.computerName} (${computer.computerId})`)
    console.log(`  Last uploaded file: ${formatTimestamp(computer.lastFileUploadedTimestamp)}`)
    if (seen >= maxComputers) break
  }

  if (seen === 0) {
    console.log('No active Computer Backup records matched the request.')
  } else if (seen >= maxComputers) {
    console.log(`Stopped after ${maxComputers} computer(s); raise B2_MAX_COMPUTERS to list more.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
