/**
 * Authorize Partner and Computer Backup API access with a Master Application Key.
 *
 * Usage:
 *   B2_MASTER_KEY_ID=xxx B2_MASTER_KEY=yyy npx tsx examples/partner-authorize.ts
 */

import { partnerClientFromEnv } from './_shared/partner.ts'

async function main() {
  const partner = partnerClientFromEnv()
  const auth = await partner.authorize()

  console.log(`Authorized partner administrator account: ${auth.accountId}`)
  console.log(`Partner API URL: ${auth.groupsApiUrl ?? 'not available for this key'}`)
  console.log(`Computer Backup API URL: ${auth.backupApiUrl ?? 'not available for this key'}`)
  console.log(`Partner capabilities: ${(auth.groupsCapabilities ?? []).join(', ') || 'none'}`)
  console.log(`Backup capabilities: ${(auth.backupCapabilities ?? []).join(', ') || 'none'}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
