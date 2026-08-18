import { B2PartnerAuthorizationError } from '../errors/index.ts'
import type { PartnerAuthorizeResponse, PartnerCapability } from '../types/partner.ts'
import { PARTNER_TOKEN_REDACTED } from './redaction-placeholders.ts'

function sameCapabilities(
  left: readonly PartnerCapability[] | undefined,
  right: readonly PartnerCapability[],
): boolean {
  return (
    left !== undefined && left.length === right.length && left.every((cap, i) => cap === right[i])
  )
}

/**
 * Validates that Partner authorize convenience fields mirror authoritative apiInfo suites.
 *
 * @param auth - Partner authorize response to validate.
 *
 * @throws B2PartnerAuthorizationError if suite and convenience fields disagree.
 *
 * @internal
 */
export function validatePartnerAuthorizeResponseShape(auth: PartnerAuthorizeResponse): void {
  if (auth.authorizationToken === PARTNER_TOKEN_REDACTED) {
    throw new B2PartnerAuthorizationError(
      'Partner authorization token was redacted; persist with partnerAuthorizeResponseForPersistence(auth) or reauthorize before reusing cached auth',
    )
  }

  const { groupsApi, backupApi } = auth.apiInfo
  if (groupsApi === undefined && backupApi === undefined) {
    throw new B2PartnerAuthorizationError(
      'Partner authorization must include apiInfo.groupsApi or apiInfo.backupApi',
    )
  }

  if (groupsApi === undefined) {
    if (auth.groupsApiUrl !== undefined || auth.groupsCapabilities !== undefined) {
      throw new B2PartnerAuthorizationError(
        'Partner authorization groups convenience fields require apiInfo.groupsApi',
      )
    }
  } else {
    if (auth.groupsApiUrl !== undefined && auth.groupsApiUrl !== groupsApi.groupsApiUrl) {
      throw new B2PartnerAuthorizationError(
        'Partner authorization groupsApiUrl does not match apiInfo.groupsApi.groupsApiUrl',
      )
    }
    if (
      auth.groupsCapabilities !== undefined &&
      !sameCapabilities(auth.groupsCapabilities, groupsApi.capabilities)
    ) {
      throw new B2PartnerAuthorizationError(
        'Partner authorization groupsCapabilities do not match apiInfo.groupsApi.capabilities',
      )
    }
  }

  if (backupApi === undefined) {
    if (auth.backupApiUrl !== undefined || auth.backupCapabilities !== undefined) {
      throw new B2PartnerAuthorizationError(
        'Partner authorization backup convenience fields require apiInfo.backupApi',
      )
    }
  } else {
    if (auth.backupApiUrl !== undefined && auth.backupApiUrl !== backupApi.backupApiUrl) {
      throw new B2PartnerAuthorizationError(
        'Partner authorization backupApiUrl does not match apiInfo.backupApi.backupApiUrl',
      )
    }
    if (
      auth.backupCapabilities !== undefined &&
      !sameCapabilities(auth.backupCapabilities, backupApi.capabilities)
    ) {
      throw new B2PartnerAuthorizationError(
        'Partner authorization backupCapabilities do not match apiInfo.backupApi.capabilities',
      )
    }
  }
}
