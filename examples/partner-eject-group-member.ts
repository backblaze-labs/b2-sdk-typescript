/**
 * Eject a member account from a Partner group without deleting the account.
 *
 * Usage:
 *   B2_CONFIRM_EJECT=1 B2_MASTER_KEY_ID=xxx B2_MASTER_KEY=yyy npx tsx examples/partner-eject-group-member.ts <group-id> <member-account-id> [replacement-email]
 */

import { accountId, groupId } from '@backblaze-labs/b2-sdk/partner'
import { fail, requireConfirmation } from './_shared/env.ts'
import { partnerClientFromEnv } from './_shared/partner.ts'

async function main() {
  const rawGroupId = process.argv[2]
  const rawMemberAccountId = process.argv[3]
  const replacementEmail = process.argv[4]?.trim() || undefined

  if (rawGroupId === undefined || rawMemberAccountId === undefined) {
    fail(
      'Usage: B2_CONFIRM_EJECT=1 npx tsx examples/partner-eject-group-member.ts <group-id> <member-account-id> [replacement-email]',
    )
  }
  requireConfirmation('B2_CONFIRM_EJECT', 'Ejecting a group member changes the member account.')

  const partner = partnerClientFromEnv()
  await partner.authorize()

  const ejected = await partner.ejectGroupMember({
    groupId: groupId(rawGroupId),
    memberAccountId: accountId(rawMemberAccountId),
    ...(replacementEmail !== undefined ? { email: replacementEmail } : {}),
  })

  console.log(`Ejected member account: ${ejected.accountId}`)
  console.log(`Email: ${ejected.email}`)
  console.log(`Former group: ${ejected.groupName} (${ejected.groupId})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
