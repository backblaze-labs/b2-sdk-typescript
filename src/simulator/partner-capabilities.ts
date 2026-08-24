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

export type PartnerCapabilitySuite = 'groups' | 'backup'

export interface PartnerEndpointCapabilityRequirement {
  readonly suite: PartnerCapabilitySuite
  readonly capabilities: readonly PartnerCapability[]
}

export const PARTNER_ENDPOINT_CAPABILITIES: Record<string, PartnerEndpointCapabilityRequirement> = {
  b2_create_group_member: { suite: 'groups', capabilities: [PartnerCapability.All] },
  b2_eject_group_member: { suite: 'groups', capabilities: [PartnerCapability.All] },
  b2_list_groups: { suite: 'groups', capabilities: [PartnerCapability.All] },
  b2_list_group_members: { suite: 'groups', capabilities: [PartnerCapability.All] },
  b2_reserve_trial_create_account: { suite: 'groups', capabilities: [PartnerCapability.All] },
  bz_list_computers: { suite: 'backup', capabilities: [PartnerCapability.All] },
  bz_delete_computer: { suite: 'backup', capabilities: [PartnerCapability.All] },
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
  endpoint: string,
  granted: readonly PartnerCapability[],
): readonly PartnerCapability[] {
  const required = PARTNER_ENDPOINT_CAPABILITIES[endpoint]?.capabilities ?? []
  const grantedSet = new Set(granted)
  return required.filter((capability) => !grantedSet.has(capability))
}
