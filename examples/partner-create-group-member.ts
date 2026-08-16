/**
 * Create a Backblaze account and add it to a Partner group.
 *
 * Usage:
 *   B2_CONFIRM_CREATE_GROUP_MEMBER=1 B2_MASTER_KEY_ID=xxx B2_MASTER_KEY=yyy npx tsx examples/partner-create-group-member.ts <group-id> <member-email> [region]
 */

import { groupId } from '@backblaze-labs/b2-sdk/partner'
import { fail, printApplicationKeySecret, requireConfirmation } from './_shared/env.ts'
import { parseRegion, partnerClientFromEnv } from './_shared/partner.ts'

async function main() {
  const rawGroupId = process.argv[2]
  const memberEmail = process.argv[3]

  if (rawGroupId === undefined || memberEmail === undefined) {
    fail(
      'Usage: B2_CONFIRM_CREATE_GROUP_MEMBER=1 npx tsx examples/partner-create-group-member.ts <group-id> <member-email> [region]',
    )
  }
  const region = parseRegion(process.argv[4])
  requireConfirmation(
    'B2_CONFIRM_CREATE_GROUP_MEMBER',
    'Creating a group member creates a new account.',
  )

  const partner = partnerClientFromEnv()
  await partner.authorize()

  const created = await partner.createGroupMember({
    groupId: groupId(rawGroupId),
    memberEmail,
    ...(region !== undefined ? { region } : {}),
  })

  for (const result of created) {
    console.log(`Created member account: ${result.groupMember.accountId}`)
    console.log(`Email: ${result.groupMember.email}`)
    console.log(`Group: ${result.groupMember.groupName} (${result.groupMember.groupId})`)
    console.log(`Application key ID: ${result.applicationKeyId}`)
    printApplicationKeySecret(result.applicationKey)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
