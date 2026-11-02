import type { PartnerClient } from '../../src/partner/index.ts'
import type { GroupId } from '../../src/types/ids.ts'
import type { ListedGroupMember } from '../../src/types/partner.ts'

/**
 * Pages through `b2_list_group_members` until `predicate` matches a member.
 *
 * `listGroupMembers` resolves to a single `ListGroupMembersResult` object
 * (`{ groupId, groupName, nextEmail, groupMembers }`), not an array, so the
 * members and the continuation cursor are read directly from the response.
 * Returns `null` once the last page (`nextEmail` null) has been searched.
 */
export async function findGroupMember(
  livePartner: Pick<PartnerClient, 'listGroupMembers'>,
  groupId: GroupId,
  predicate: (member: ListedGroupMember) => boolean,
): Promise<ListedGroupMember | null> {
  let startEmail: string | undefined
  for (;;) {
    const page = await livePartner.listGroupMembers({
      groupId,
      pageSize: 1000,
      ...(startEmail !== undefined ? { startEmail } : {}),
    })
    const member = page.groupMembers.find(predicate)
    if (member !== undefined) return member

    const nextEmail = page.nextEmail
    if (nextEmail === undefined || nextEmail === null) return null
    startEmail = nextEmail
  }
}
