import { describe, expect, it } from 'vitest'
import {
  InMemoryPartnerAccountInfo as BackupAccountInfo,
  BackupClient,
  PartnerCapability as BackupPartnerCapability,
  BackupRawClient,
  partnerAuthorizeResponseToPersistableJson as backupAuthToPersistableJson,
  computerId,
} from './backup/index.ts'
import {
  InMemoryPartnerAccountInfo,
  PartnerCapability,
  PartnerClient,
  PartnerRawClient,
  partnerAuthorizeResponseToPersistableJson,
  Region,
} from './partner/index.ts'

describe('Partner and Backup subpath imports', () => {
  it('exposes facade, raw, shared auth, and enum exports', () => {
    expect(PartnerClient).toBeTypeOf('function')
    expect(PartnerRawClient).toBeTypeOf('function')
    expect(BackupClient).toBeTypeOf('function')
    expect(BackupRawClient).toBeTypeOf('function')
    expect(InMemoryPartnerAccountInfo).toBe(BackupAccountInfo)
    expect(partnerAuthorizeResponseToPersistableJson).toBe(backupAuthToPersistableJson)
    expect(PartnerCapability.All).toBe('all')
    expect(BackupPartnerCapability.All).toBe('all')
    expect(Region.UsWest).toBe('us-west')
    expect(computerId('computer-id')).toBe('computer-id')
  })
})
