import type { AuthorizeAccountResponse } from './types/auth.ts'
import type { DownloadAuthorizationResponse } from './types/download.ts'
import type { GetUploadUrlResponse } from './types/upload.ts'

/** Placeholder used when an authorization token appears in diagnostic output. */
export const AUTHORIZATION_TOKEN_REDACTED = '[redacted authorization token]'

type AuthorizationTokenResponse = { readonly authorizationToken: string }

type RedactedAuthorizationTokenResponseJson<T extends AuthorizationTokenResponse> = Omit<
  T,
  'authorizationToken'
> & {
  readonly authorizationToken: string
}

const inspectSymbol = Symbol.for('nodejs.util.inspect.custom')

function redactedAuthorizationTokenJson<T extends AuthorizationTokenResponse>(
  response: T,
): RedactedAuthorizationTokenResponseJson<T> {
  return { ...response, authorizationToken: AUTHORIZATION_TOKEN_REDACTED }
}

// Bun/WebKit only honor object toJSON hooks when they are inherited, while Node
// honors own hooks. Install both shapes for consistent diagnostic serialization.
function installPortableJsonHook<T extends object>(target: T, toJson: () => unknown): void {
  const originalPrototype = Object.getPrototypeOf(target)
  const redactionPrototype = Object.create(originalPrototype) as object
  Object.defineProperty(redactionPrototype, 'toJSON', {
    value: toJson,
    enumerable: false,
    configurable: true,
  })
  Object.setPrototypeOf(target, redactionPrototype)
  Object.defineProperty(target, 'toJSON', {
    value: toJson,
    enumerable: false,
    configurable: true,
  })
}

function redactAuthorizationTokenResponse<T extends AuthorizationTokenResponse>(response: T): T {
  const target = Object.isExtensible(response) ? response : ({ ...response } as T)
  const toRedactedJson = (): RedactedAuthorizationTokenResponseJson<T> =>
    redactedAuthorizationTokenJson(target)

  installPortableJsonHook(target, toRedactedJson)
  Object.defineProperty(target, inspectSymbol, {
    value: toRedactedJson,
    enumerable: false,
    configurable: true,
  })
  return target
}

/**
 * Rejects a response reconstructed from diagnostic JSON before it can be reused.
 *
 * @param response - Response that carries an authorization token.
 * @param responseName - Name used in the diagnostic error message.
 *
 * @throws TypeError when the response carries the diagnostic placeholder.
 *
 * @internal
 */
export function assertAuthorizationTokenCanBeRehydrated(
  response: AuthorizationTokenResponse,
  responseName: string,
): void {
  if (response.authorizationToken === AUTHORIZATION_TOKEN_REDACTED) {
    throw new TypeError(
      `${responseName} has a redacted authorization token; use its persistence helper before serializing`,
    )
  }
}

function responseForPersistence<T extends AuthorizationTokenResponse>(
  response: T,
  responseName: string,
): T {
  assertAuthorizationTokenCanBeRehydrated(response, responseName)
  return { ...response }
}

/**
 * Adds non-enumerable JSON and Node inspection hooks to an authorize response.
 * Direct `authorizationToken` access continues to return the real token.
 *
 * @param response - Authorize response to render consistently in diagnostics.
 *
 * @returns The response with non-enumerable diagnostic hooks installed.
 *
 * @internal
 */
export function redactAuthorizeAccountResponse(
  response: AuthorizeAccountResponse,
): AuthorizeAccountResponse {
  return redactAuthorizationTokenResponse(response)
}

/**
 * Adds non-enumerable JSON and Node inspection hooks to a download-authorization response.
 * Direct `authorizationToken` access continues to return the real token.
 *
 * @param response - Download-authorization response to render consistently in diagnostics.
 *
 * @returns The response with non-enumerable diagnostic hooks installed.
 *
 * @internal
 */
export function redactDownloadAuthorizationResponse(
  response: DownloadAuthorizationResponse,
): DownloadAuthorizationResponse {
  return redactAuthorizationTokenResponse(response)
}

/**
 * Adds non-enumerable JSON and Node inspection hooks to an upload-URL response.
 * Direct `authorizationToken` access continues to return the real token.
 *
 * @param response - Upload-URL response to render consistently in diagnostics.
 *
 * @returns The response with non-enumerable diagnostic hooks installed.
 *
 * @internal
 */
export function redactGetUploadUrlResponse(response: GetUploadUrlResponse): GetUploadUrlResponse {
  return redactAuthorizationTokenResponse(response)
}

/**
 * Returns a hook-free authorize response suitable for trusted persistence.
 * The result preserves the real authorization token and can be serialized,
 * parsed, and passed to `AccountInfo.setAuth()`.
 *
 * @param response - Authorize response to persist.
 *
 * @returns A plain authorize response with the real token preserved.
 */
export function authorizeAccountResponseForPersistence(
  response: AuthorizeAccountResponse,
): AuthorizeAccountResponse {
  return responseForPersistence(response, 'Authorize response')
}

/**
 * Returns a hook-free download-authorization response suitable for trusted persistence.
 * The result preserves the real authorization token.
 *
 * @param response - Download-authorization response to persist.
 *
 * @returns A plain download-authorization response with the real token preserved.
 */
export function downloadAuthorizationResponseForPersistence(
  response: DownloadAuthorizationResponse,
): DownloadAuthorizationResponse {
  return responseForPersistence(response, 'Download authorization response')
}

/**
 * Returns a hook-free upload-URL response suitable for trusted persistence.
 * The result preserves the real authorization token and can be returned to an
 * upload URL pool.
 *
 * @param response - Upload-URL response to persist.
 *
 * @returns A plain upload-URL response with the real token preserved.
 */
export function getUploadUrlResponseForPersistence(
  response: GetUploadUrlResponse,
): GetUploadUrlResponse {
  return responseForPersistence(response, 'Upload URL response')
}
