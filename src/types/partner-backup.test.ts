import { describe, expect, it } from 'vitest'
import type {
  CreateGroupMemberResponse,
  DeleteComputerResponse,
  EjectGroupMemberResponse,
  ListComputersResponse,
  ListGroupMembersResponse,
  ListGroupsResponse,
  ReserveTrialCreateAccountResponse,
} from './index.ts'
import { accountId, applicationKeyId, bucketId, computerId, groupId, Region } from './index.ts'

describe('partner and backup wire response shapes', () => {
  it('models successful Partner API response shapes', () => {
    const adminAccountId = accountId('admin-account')
    const memberAccountId = accountId('member-account')
    const group = groupId('254')
    const key = applicationKeyId('application-key-id')
    const bucket = bucketId('bucket-id')
    const b2Stats = {
      b2BytesStoredCount: '1024',
      b2FilesStoredCount: '3',
      b2StatsAsOfTimestamp: '2026-08-14T00:00:00Z',
      bucketCount: '1',
    }
    const groupMember = {
      accountId: memberAccountId,
      email: 'member@example.com',
      groupId: group,
      groupName: 'Example Group',
      region: Region.UsWest,
      s3Endpoint: 's3.us-west-004.backblazeb2.com',
    }

    const createGroupMember: CreateGroupMemberResponse = [
      {
        applicationKey: 'application-key-secret',
        applicationKeyId: key,
        groupMember,
      },
    ]
    const ejectGroupMember: EjectGroupMemberResponse = groupMember
    const listGroups: ListGroupsResponse = {
      accountId: adminAccountId,
      groups: [
        {
          accountStandingDetails: { state: 'active' },
          b2Stats,
          groupId: group,
          groupName: 'Example Group',
          groupProducts: ['BACKUP', 'STORAGE'],
          groupStats: {
            createdTimestamp: '2026-08-14T00:00:00Z',
            groupStatsAsOfTimestamp: '2026-08-14T00:00:00Z',
            memberCount: 1,
          },
        },
      ],
      nextGroupId: null,
    }
    const listGroupMembers: ListGroupMembersResponse = [
      {
        groupId: group,
        groupMembers: [{ ...groupMember, b2Stats }],
        groupName: 'Example Group',
        nextEmail: null,
      },
    ]
    const reserveTrialCreateAccount: ReserveTrialCreateAccountResponse = [
      {
        accountId: memberAccountId,
        applicationKey: 'application-key-secret',
        applicationKeyId: key,
        bucketId: bucket,
        bucketName: 'trial-bucket',
        email: 'member@example.com',
        endDate: '2026-09-13',
        s3Endpoint: 's3.us-west-004.backblazeb2.com',
        startDate: '2026-08-14',
      },
    ]

    expect(createGroupMember[0]?.groupMember.groupId).toBe(group)
    expect(ejectGroupMember.email).toBe('member@example.com')
    expect(listGroups.groups[0]?.b2Stats.bucketCount).toBe('1')
    expect(listGroupMembers[0]?.groupMembers[0]?.b2Stats.b2FilesStoredCount).toBe('3')
    expect(reserveTrialCreateAccount[0]?.bucketId).toBe(bucket)
  })

  it('models successful Computer Backup API responses as arrays', () => {
    const account = accountId('account-id')
    const computer = computerId('deb0b1bcd412a7759709081c')
    const listComputers: ListComputersResponse = [
      {
        computers: [
          {
            computerId: computer,
            computerName: 'workstation',
            lastFileUploadedTimestamp: 1_786_662_000_000,
          },
        ],
        nextComputerId: null,
      },
    ]
    const deleteComputer: DeleteComputerResponse = [
      {
        computerId: computer,
        computerName: 'workstation',
        lastFileUploadedTimestamp: 1_786_662_000_000,
      },
    ]

    expect(account).toBe('account-id')
    expect(listComputers[0]?.computers[0]?.computerId).toBe(computer)
    expect(deleteComputer[0]?.computerName).toBe('workstation')
  })
})
