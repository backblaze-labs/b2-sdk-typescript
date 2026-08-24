import { describe, expect, it } from 'vitest'
import { PartnerCapability } from '../types/partner.ts'
import {
  missingPartnerCapabilitiesFor,
  PARTNER_ENDPOINT_CAPABILITIES,
} from './partner-capabilities.ts'

describe('PARTNER_ENDPOINT_CAPABILITIES', () => {
  it('covers every Partner and Computer Backup simulator endpoint', () => {
    expect(Object.keys(PARTNER_ENDPOINT_CAPABILITIES).sort()).toEqual([
      'b2_create_group_member',
      'b2_eject_group_member',
      'b2_list_group_members',
      'b2_list_groups',
      'b2_reserve_trial_create_account',
      'bz_delete_computer',
      'bz_list_computers',
    ])

    expect(PARTNER_ENDPOINT_CAPABILITIES['b2_create_group_member']).toMatchObject({
      suite: 'groups',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES['b2_eject_group_member']).toMatchObject({
      suite: 'groups',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES['b2_list_groups']).toMatchObject({
      suite: 'groups',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES['b2_list_group_members']).toMatchObject({
      suite: 'groups',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES['b2_reserve_trial_create_account']).toMatchObject({
      suite: 'groups',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES['bz_list_computers']).toMatchObject({
      suite: 'backup',
      capabilities: [PartnerCapability.All],
    })
    expect(PARTNER_ENDPOINT_CAPABILITIES['bz_delete_computer']).toMatchObject({
      suite: 'backup',
      capabilities: [PartnerCapability.All],
    })
  })
})

describe('missingPartnerCapabilitiesFor', () => {
  it('returns an empty list when all required Partner capabilities are granted', () => {
    expect(missingPartnerCapabilitiesFor('b2_list_groups', [PartnerCapability.All])).toEqual([])
  })

  it('returns the required Partner capabilities missing from the grant', () => {
    expect(missingPartnerCapabilitiesFor('bz_list_computers', [])).toEqual([PartnerCapability.All])
  })

  it('treats unknown endpoints as having no Partner capability requirement', () => {
    expect(missingPartnerCapabilitiesFor('unknown_endpoint', [])).toEqual([])
  })
})
