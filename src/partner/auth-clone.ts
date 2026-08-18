import type { PartnerAuthorizeResponse } from '../types/partner.ts'
import { validatePartnerAuthorizeResponseShape } from './auth-shape.ts'

/**
 * Returns a hook-free Partner authorize response copy.
 *
 * @param auth - Partner authorization response to clone.
 *
 * @returns A plain object preserving the live Partner token.
 *
 * @internal
 */
export function clonePartnerAuthorizeResponse(
  auth: PartnerAuthorizeResponse,
): PartnerAuthorizeResponse {
  validatePartnerAuthorizeResponseShape(auth)

  const storageApi = auth.apiInfo.storageApi
  const groupsApi = auth.apiInfo.groupsApi
  const backupApi = auth.apiInfo.backupApi

  return {
    accountId: auth.accountId,
    authorizationToken: auth.authorizationToken,
    apiInfo: {
      ...(storageApi !== undefined
        ? {
            storageApi: {
              ...storageApi,
              capabilities: [...storageApi.capabilities],
            },
          }
        : {}),
      ...(groupsApi !== undefined
        ? {
            groupsApi: {
              ...groupsApi,
              capabilities: [...groupsApi.capabilities],
              infoType: 'groupsApi' as const,
            },
          }
        : {}),
      ...(backupApi !== undefined
        ? {
            backupApi: {
              ...backupApi,
              capabilities: [...backupApi.capabilities],
              infoType: 'backupApi' as const,
            },
          }
        : {}),
    },
    ...(groupsApi !== undefined ? { groupsApiUrl: groupsApi.groupsApiUrl } : {}),
    ...(backupApi !== undefined ? { backupApiUrl: backupApi.backupApiUrl } : {}),
    ...(groupsApi !== undefined ? { groupsCapabilities: [...groupsApi.capabilities] } : {}),
    ...(backupApi !== undefined ? { backupCapabilities: [...backupApi.capabilities] } : {}),
    applicationKeyExpirationTimestamp: auth.applicationKeyExpirationTimestamp,
  }
}

/**
 * Returns a plain Partner authorize response copy for trusted auth-cache persistence.
 *
 * Unlike `JSON.stringify(auth)`, this preserves `authorizationToken` so the
 * result can be serialized, parsed, and passed back to
 * `PartnerAccountInfo.setAuth()`.
 *
 * The returned value is raw bearer-token material. Store it only in encrypted
 * or otherwise credential-grade durable storage, and never log it.
 *
 * @param auth - Partner authorization response to persist.
 *
 * @returns A plain object with the live Partner token preserved.
 */
export function partnerAuthorizeResponseForPersistence(
  auth: PartnerAuthorizeResponse,
): PartnerAuthorizeResponse {
  return clonePartnerAuthorizeResponse(auth)
}
