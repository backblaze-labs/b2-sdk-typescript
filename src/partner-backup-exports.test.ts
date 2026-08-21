import { describe, expect, it } from 'vitest'
import {
  InMemoryPartnerAccountInfo as BackupAccountInfo,
  BackupClient,
  PartnerCapability as BackupPartnerCapability,
  BackupRawClient,
  partnerAuthorizeResponseForPersistence as backupAuthForPersistence,
  computerId,
} from './backup/index.ts'
import {
  APPLICATION_KEY_REDACTED,
  createGroupMemberResponseToRedactedJson,
  createGroupMemberResultToRedactedJson,
  InMemoryPartnerAccountInfo,
  PARTNER_TOKEN_REDACTED,
  PartnerCapability,
  PartnerClient,
  PartnerRawClient,
  partnerAuthorizeResponseForPersistence,
  partnerAuthorizeResponseToRedactedJson,
  Region,
  reserveTrialCreateAccountResponseToRedactedJson,
  reserveTrialCreateAccountResultToRedactedJson,
} from './partner/index.ts'

describe('Partner and Backup subpath imports', () => {
  it('exposes facade, raw, shared auth, and enum exports', () => {
    expect(PartnerClient).toBeTypeOf('function')
    expect(PartnerRawClient).toBeTypeOf('function')
    expect(BackupClient).toBeTypeOf('function')
    expect(BackupRawClient).toBeTypeOf('function')
    expect(InMemoryPartnerAccountInfo).toBe(BackupAccountInfo)
    expect(partnerAuthorizeResponseForPersistence).toBe(backupAuthForPersistence)
    expect(PartnerCapability.All).toBe('all')
    expect(BackupPartnerCapability.All).toBe('all')
    expect(Region.UsWest).toBe('us-west')
    expect(computerId('computer-id')).toBe('computer-id')
    expect(PARTNER_TOKEN_REDACTED).toBe('[redacted Partner token]')
    expect(APPLICATION_KEY_REDACTED).toBe('[redacted application key]')
    expect(partnerAuthorizeResponseToRedactedJson).toBeTypeOf('function')
    expect(createGroupMemberResultToRedactedJson).toBeTypeOf('function')
    expect(createGroupMemberResponseToRedactedJson).toBeTypeOf('function')
    expect(reserveTrialCreateAccountResultToRedactedJson).toBeTypeOf('function')
    expect(reserveTrialCreateAccountResponseToRedactedJson).toBeTypeOf('function')
  })
})
