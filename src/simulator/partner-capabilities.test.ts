import { describe, expect, it } from 'vitest'
import { PartnerCapability } from '../types/partner.ts'
import {
  missingPartnerCapabilities,
  missingPartnerCapabilitiesFor,
  PARTNER_ENDPOINT_CAPABILITIES,
  PARTNER_ENDPOINT_NAMES,
  PartnerEndpoint,
} from './partner-capabilities.ts'

describe('PARTNER_ENDPOINT_CAPABILITIES', () => {
  it('covers every Partner and Computer Backup simulator endpoint', () => {
    expect(Object.keys(PARTNER_ENDPOINT_CAPABILITIES).sort()).toEqual(
      [...PARTNER_ENDPOINT_NAMES].sort(),
    )

    expect(PARTNER_ENDPOINT_CAPABILITIES[PartnerEndpoint.CreateGroupMember]).toMatchObject({
      suite: 'groups',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES[PartnerEndpoint.EjectGroupMember]).toMatchObject({
      suite: 'groups',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES[PartnerEndpoint.ListGroups]).toMatchObject({
      suite: 'groups',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES[PartnerEndpoint.ListGroupMembers]).toMatchObject({
      suite: 'groups',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES[PartnerEndpoint.ReserveTrialCreateAccount]).toMatchObject({
      suite: 'groups',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES[PartnerEndpoint.ListComputers]).toMatchObject({
      suite: 'backup',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES[PartnerEndpoint.DeleteComputer]).toMatchObject({
      suite: 'backup',
      capabilities: [PartnerCapability.All],
    })
  })

  it('freezes the exported table and nested capability arrays at runtime', () => {
    expect(Object.isFrozen(PARTNER_ENDPOINT_CAPABILITIES)).toBe(true)
    for (const endpoint of PARTNER_ENDPOINT_NAMES) {
      const requirement = PARTNER_ENDPOINT_CAPABILITIES[endpoint]

      expect(Object.isFrozen(requirement)).toBe(true)
      expect(Object.isFrozen(requirement.capabilities)).toBe(true)
    }
  })
})

describe('missingPartnerCapabilitiesFor', () => {
  it('returns an empty list when all required Partner capabilities are granted', () => {
    expect(
      missingPartnerCapabilitiesFor(PartnerEndpoint.ListGroups, [PartnerCapability.All]),
    ).toEqual([])
  })

  it('returns the required Partner capabilities missing from the grant', () => {
    expect(missingPartnerCapabilitiesFor(PartnerEndpoint.ListComputers, [])).toEqual([
      PartnerCapability.All,
    ])
  })

  it('returns an empty list when no Partner capabilities are required', () => {
    expect(missingPartnerCapabilities([], [])).toEqual([])
  })
})
