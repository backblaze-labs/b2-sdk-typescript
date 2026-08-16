/**
 * List Partner groups and their active members with SDK paginators.
 *
 * Usage:
 *   B2_MASTER_KEY_ID=xxx B2_MASTER_KEY=yyy npx tsx examples/partner-list-groups-and-members.ts [group-name]
 */

import { optionalEnv, optionalPositiveInteger } from './_shared/env.ts'
import { partnerClientFromEnv } from './_shared/partner.ts'

async function main() {
  const groupName = process.argv[2]?.trim() || undefined
  const groupPageSize = optionalPositiveInteger(
    optionalEnv('B2_GROUP_PAGE_SIZE'),
    'B2_GROUP_PAGE_SIZE',
    100,
  )
  const memberPageSize = optionalPositiveInteger(
    optionalEnv('B2_MEMBER_PAGE_SIZE'),
    'B2_MEMBER_PAGE_SIZE',
    100,
  )
  const maxGroups = optionalPositiveInteger(optionalEnv('B2_MAX_GROUPS'), 'B2_MAX_GROUPS', 25)
  const maxMembersPerGroup = optionalPositiveInteger(
    optionalEnv('B2_MAX_MEMBERS_PER_GROUP'),
    'B2_MAX_MEMBERS_PER_GROUP',
    25,
  )

  const partner = await partnerClientFromEnv()
  await partner.authorize()

  let groupsSeen = 0
  for await (const group of partner.paginateGroups({
    ...(groupName !== undefined ? { groupName } : {}),
    pageSize: groupPageSize,
  })) {
    groupsSeen += 1
    console.log(`${group.groupName} (${group.groupId})`)
    console.log(`  Products: ${group.groupProducts.join(', ') || 'none'}`)
    console.log(`  Members: ${group.groupStats.memberCount}`)

    let membersSeen = 0
    for await (const member of partner.paginateGroupMembers({
      groupId: group.groupId,
      pageSize: memberPageSize,
    })) {
      membersSeen += 1
      console.log(`    ${member.email} (${member.accountId})`)
      if (membersSeen >= maxMembersPerGroup) break
    }
    if (membersSeen >= maxMembersPerGroup) {
      console.log(
        `    Stopped after ${maxMembersPerGroup} member(s); raise B2_MAX_MEMBERS_PER_GROUP to list more.`,
      )
    }
    if (groupsSeen >= maxGroups) break
  }

  if (groupsSeen === 0) {
    console.log('No Partner groups matched the request.')
  } else if (groupsSeen >= maxGroups) {
    console.log(`Stopped after ${maxGroups} group(s); raise B2_MAX_GROUPS to list more.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
