import type { AuthorizeAccountResponse } from './types/auth.ts'
import type { DownloadAuthorizationResponse } from './types/download.ts'
import type { GetUploadPartUrlResponse, GetUploadUrlResponse } from './types/upload.ts'

export const AUTHORIZATION_TOKEN_REDACTED = '[redacted authorization token]'
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom')

type TokenResponse = { readonly authorizationToken: string }

function redactResponse<T extends TokenResponse>(response: T): T {
  const target = Object.isExtensible(response) ? response : ({ ...response } as T)
  const summary = () => ({ ...target, authorizationToken: AUTHORIZATION_TOKEN_REDACTED })

  // Bun reads inherited toJSON methods; Node and browsers read the own hook.
  if ('Bun' in globalThis) {
    const prototype = Object.create(Object.getPrototypeOf(target)) as object
    Object.defineProperty(prototype, 'toJSON', { value: summary, configurable: true })
    Object.setPrototypeOf(target, prototype)
  }
  Object.defineProperty(target, 'toJSON', { value: summary, configurable: true })
  Object.defineProperty(target, INSPECT_CUSTOM, { value: summary, configurable: true })
  return target
}

function forPersistence<T extends TokenResponse>(response: T, helperName: string): T {
  if (response.authorizationToken === AUTHORIZATION_TOKEN_REDACTED) {
    throw new TypeError(`${helperName} requires the original response, not diagnostic JSON`)
  }
  return { ...response }
}

/**
 * Adds non-enumerable diagnostic hooks while preserving direct token access.
 *
 * @param response - Authorization response to prepare for diagnostics.
 *
 * @returns The response with redacted diagnostic serialization. On Bun, its prototype gains
 * an inherited non-enumerable `toJSON` method because Bun uses inherited JSON hooks.
 */
export function redactAuthorizeAccountResponse(
  response: AuthorizeAccountResponse,
): AuthorizeAccountResponse {
  return redactResponse(response)
}

/**
 * Adds non-enumerable diagnostic hooks while preserving direct token access.
 *
 * @param response - Upload URL response to prepare for diagnostics.
 *
 * @returns The response with redacted diagnostic serialization. On Bun, its prototype gains
 * an inherited non-enumerable `toJSON` method because Bun uses inherited JSON hooks.
 */
export function redactGetUploadUrlResponse(response: GetUploadUrlResponse): GetUploadUrlResponse {
  return redactResponse(response)
}

/**
 * Adds non-enumerable diagnostic hooks while preserving direct token access.
 *
 * @param response - Part upload URL response to prepare for diagnostics.
 *
 * @returns The response with redacted diagnostic serialization. On Bun, its prototype gains
 * an inherited non-enumerable `toJSON` method because Bun uses inherited JSON hooks.
 */
export function redactGetUploadPartUrlResponse(
  response: GetUploadPartUrlResponse,
): GetUploadPartUrlResponse {
  return redactResponse(response)
}

/**
 * Adds non-enumerable diagnostic hooks while preserving direct token access.
 *
 * @param response - Download authorization response to prepare for diagnostics.
 *
 * @returns The response with redacted diagnostic serialization. On Bun, its prototype gains
 * an inherited non-enumerable `toJSON` method because Bun uses inherited JSON hooks.
 */
export function redactDownloadAuthorizationResponse(
  response: DownloadAuthorizationResponse,
): DownloadAuthorizationResponse {
  return redactResponse(response)
}

/**
 * Returns a hook-free copy retaining the real token for trusted persistence.
 * Store the result only in credential-grade storage and never print it.
 *
 * @param response - Original authorization response.
 *
 * @returns A plain response copy with the real token.
 *
 * @throws TypeError if given a response rebuilt from diagnostic JSON.
 */
export function authorizeAccountResponseForPersistence(
  response: AuthorizeAccountResponse,
): AuthorizeAccountResponse {
  return forPersistence(response, 'authorizeAccountResponseForPersistence')
}

/**
 * Returns a hook-free copy retaining the real token for trusted persistence.
 * Store the result only in credential-grade storage and never print it.
 *
 * @param response - Original upload URL response.
 *
 * @returns A plain response copy with the real token.
 *
 * @throws TypeError if given a response rebuilt from diagnostic JSON.
 */
export function getUploadUrlResponseForPersistence(
  response: GetUploadUrlResponse,
): GetUploadUrlResponse {
  return forPersistence(response, 'getUploadUrlResponseForPersistence')
}

/**
 * Returns a hook-free copy retaining the real token for trusted persistence.
 * Store the result only in credential-grade storage and never print it.
 *
 * @param response - Original part upload URL response.
 *
 * @returns A plain response copy with the real token.
 *
 * @throws TypeError if given a response rebuilt from diagnostic JSON.
 */
export function getUploadPartUrlResponseForPersistence(
  response: GetUploadPartUrlResponse,
): GetUploadPartUrlResponse {
  return forPersistence(response, 'getUploadPartUrlResponseForPersistence')
}

/**
 * Returns a hook-free copy retaining the real token for trusted persistence.
 * Store the result only in credential-grade storage and never print it.
 *
 * @param response - Original download authorization response.
 *
 * @returns A plain response copy with the real token.
 *
 * @throws TypeError if given a response rebuilt from diagnostic JSON.
 */
export function downloadAuthorizationResponseForPersistence(
  response: DownloadAuthorizationResponse,
): DownloadAuthorizationResponse {
  return forPersistence(response, 'downloadAuthorizationResponseForPersistence')
}
