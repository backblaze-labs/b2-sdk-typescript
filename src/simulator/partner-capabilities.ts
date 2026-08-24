/**
 * Partner and Computer Backup endpoint capability requirements.
 *
 * Partner tokens carry suite-specific grants that are independent from
 * storage application-key capabilities. The simulator uses this table only
 * for strict Partner/Backup auth checks.
 *
 * Source: https://www.backblaze.com/apidocs (Partner endpoint pages list
 * valid-token authorization failures as `401 unauthorized`).
 *
 * @packageDocumentation
 */

import { PartnerCapability } from '../types/partner.ts'

export const PartnerEndpoint = Object.freeze({
  CreateGroupMember: 'b2_create_group_member',
  EjectGroupMember: 'b2_eject_group_member',
  ListGroups: 'b2_list_groups',
  ListGroupMembers: 'b2_list_group_members',
  ReserveTrialCreateAccount: 'b2_reserve_trial_create_account',
  ListComputers: 'bz_list_computers',
  DeleteComputer: 'bz_delete_computer',
} as const)

export type PartnerEndpoint = (typeof PartnerEndpoint)[keyof typeof PartnerEndpoint]

export const PARTNER_ENDPOINT_NAMES = Object.freeze([
  PartnerEndpoint.CreateGroupMember,
  PartnerEndpoint.EjectGroupMember,
  PartnerEndpoint.ListGroups,
  PartnerEndpoint.ListGroupMembers,
  PartnerEndpoint.ReserveTrialCreateAccount,
  PartnerEndpoint.ListComputers,
  PartnerEndpoint.DeleteComputer,
] as const)

export type PartnerCapabilitySuite = 'groups' | 'backup'

export interface PartnerEndpointCapabilityRequirement {
  readonly suite: PartnerCapabilitySuite
  readonly capabilities: readonly PartnerCapability[]
}

function endpointRequirement(
  suite: PartnerCapabilitySuite,
  capabilities: readonly PartnerCapability[],
): PartnerEndpointCapabilityRequirement {
  return Object.freeze({
    suite,
    capabilities: Object.freeze([...capabilities]),
  })
}

export const PARTNER_ENDPOINT_CAPABILITIES = Object.freeze({
  [PartnerEndpoint.CreateGroupMember]: endpointRequirement('groups', [PartnerCapability.All]),
  [PartnerEndpoint.EjectGroupMember]: endpointRequirement('groups', [PartnerCapability.All]),
  [PartnerEndpoint.ListGroups]: endpointRequirement('groups', [PartnerCapability.All]),
  [PartnerEndpoint.ListGroupMembers]: endpointRequirement('groups', [PartnerCapability.All]),
  [PartnerEndpoint.ReserveTrialCreateAccount]: endpointRequirement('groups', [
    PartnerCapability.All,
  ]),
  [PartnerEndpoint.ListComputers]: endpointRequirement('backup', [PartnerCapability.All]),
  [PartnerEndpoint.DeleteComputer]: endpointRequirement('backup', [PartnerCapability.All]),
} satisfies Record<PartnerEndpoint, PartnerEndpointCapabilityRequirement>)

/**
 * Resolve the frozen capability requirement for a Partner or Backup endpoint.
 *
 * @param endpoint - Partner or Computer Backup endpoint name.
 *
 * @returns The endpoint's requirement, or null when no policy is available.
 */
export function partnerEndpointCapabilityRequirementFor(
  endpoint: PartnerEndpoint,
): PartnerEndpointCapabilityRequirement | null {
  return PARTNER_ENDPOINT_CAPABILITIES[endpoint] ?? null
}

/**
 * Find missing Partner capabilities against an already-resolved requirement.
 *
 * @param required - Partner capabilities required by the endpoint.
 * @param granted - Partner capabilities granted by the token suite.
 *
 * @returns The subset of required Partner capabilities absent from `granted`.
 */
export function missingPartnerCapabilities(
  required: readonly PartnerCapability[],
  granted: readonly PartnerCapability[],
): readonly PartnerCapability[] {
  const grantedSet = new Set(granted)
  return required.filter((capability) => !grantedSet.has(capability))
}

/**
 * Find which Partner capabilities are missing from the caller's grant set.
 *
 * @param endpoint - Partner or Computer Backup endpoint name.
 * @param granted - Suite capabilities carried by the Partner token.
 *
 * @returns The required Partner capabilities not present in `granted`.
 */
export function missingPartnerCapabilitiesFor(
  endpoint: PartnerEndpoint,
  granted: readonly PartnerCapability[],
): readonly PartnerCapability[] {
  return missingPartnerCapabilities(
    partnerEndpointCapabilityRequirementFor(endpoint)?.capabilities ?? [],
    granted,
  )
}
