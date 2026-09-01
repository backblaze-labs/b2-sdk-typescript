/**
 * Create a Backblaze account and add it to a Partner group.
 *
 * Usage:
 *   B2_CONFIRM_CREATE_GROUP_MEMBER=1 B2_APPLICATION_KEY_FILE=./member-key.json B2_MASTER_KEY_ID=xxx B2_MASTER_KEY=yyy npx tsx examples/partner-create-group-member.ts <group-id> <member-email> [region]
 */

import { groupId } from '@backblaze-labs/b2-sdk/partner'
import {
  applicationKeyFilePathFromEnv,
  createApplicationKeySecretsFile,
  fail,
  requireConfirmation,
} from './_shared/env.ts'
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
  const applicationKeyFilePath = applicationKeyFilePathFromEnv()
  requireConfirmation(
    'B2_CONFIRM_CREATE_GROUP_MEMBER',
    'Creating a group member creates a new account.',
  )
  const secretsFile = await createApplicationKeySecretsFile(applicationKeyFilePath)

  try {
    const partner = await partnerClientFromEnv()
    await partner.authorize()

    const created = await partner.createGroupMember({
      groupId: groupId(rawGroupId),
      memberEmail,
      ...(region !== undefined ? { region } : {}),
    })

    await secretsFile.write([
      {
        accountId: created.groupMember.accountId,
        applicationKeyId: created.applicationKeyId,
        applicationKey: created.applicationKey,
        email: created.groupMember.email,
        s3Endpoint: created.groupMember.s3Endpoint,
      },
    ])

    console.log(`Created member account: ${created.groupMember.accountId}`)
    console.log(`Email: ${created.groupMember.email}`)
    console.log(`Group: ${created.groupMember.groupName} (${created.groupMember.groupId})`)
    console.log(`Application key ID: ${created.applicationKeyId}`)
    console.log(`Application key secret: written to ${applicationKeyFilePath}`)
  } finally {
    await secretsFile.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
