import { describe, expect, it, vi } from 'vitest'
import type { PartnerClient } from '../../src/partner/index.ts'
import { accountId, groupId } from '../../src/types/ids.ts'
import type { ListedGroupMember, ListGroupMembersResponse } from '../../src/types/partner.ts'
import { findGroupMember } from './partner-members.ts'

const gid = groupId('group-1')

function member(email: string): ListedGroupMember {
  return {
    accountId: accountId(`acct-${email}`),
    email,
    groupId: gid,
    groupName: 'Group One',
    region: 'us-west' as ListedGroupMember['region'],
    s3Endpoint: 's3.us-west-004.backblazeb2.com',
    b2Stats: {
      b2BytesStoredCount: 0,
      b2FilesStoredCount: 0,
      b2StatsAsOfTimestamp: null,
      bucketCount: 0,
    },
  }
}

/** A `b2_list_group_members` page: one object, never an array. */
function page(members: ListedGroupMember[], nextEmail: string | null): ListGroupMembersResponse {
  return { groupId: gid, groupName: 'Group One', nextEmail, groupMembers: members }
}

function fakePartner(pages: ListGroupMembersResponse[]) {
  const listGroupMembers = vi.fn(async () => {
    const next = pages.shift()
    if (next === undefined) throw new Error('listGroupMembers called more often than expected')
    return next
  })
  return { listGroupMembers } satisfies Pick<PartnerClient, 'listGroupMembers'>
}

describe('findGroupMember (integration test helper)', () => {
  it('finds a member on the first page of the single-object response', async () => {
    const target = member('b@example.test')
    const partner = fakePartner([page([member('a@example.test'), target], null)])

    const found = await findGroupMember(partner, gid, (m) => m.email === 'b@example.test')

    expect(found).toBe(target)
    expect(partner.listGroupMembers).toHaveBeenCalledTimes(1)
    expect(partner.listGroupMembers).toHaveBeenCalledWith({ groupId: gid, pageSize: 1000 })
  })

  it('follows nextEmail to later pages until the member is found', async () => {
    const target = member('z@example.test')
    const partner = fakePartner([
      page([member('a@example.test')], 'm@example.test'),
      page([target], null),
    ])

    const found = await findGroupMember(partner, gid, (m) => m.email === 'z@example.test')

    expect(found).toBe(target)
    expect(partner.listGroupMembers).toHaveBeenCalledTimes(2)
    expect(partner.listGroupMembers).toHaveBeenLastCalledWith({
      groupId: gid,
      pageSize: 1000,
      startEmail: 'm@example.test',
    })
  })

  it('returns null after the last page when nothing matches', async () => {
    const partner = fakePartner([
      page([member('a@example.test')], 'm@example.test'),
      page([member('n@example.test')], null),
    ])

    const found = await findGroupMember(partner, gid, (m) => m.email === 'missing@example.test')

    expect(found).toBeNull()
    expect(partner.listGroupMembers).toHaveBeenCalledTimes(2)
  })
})
