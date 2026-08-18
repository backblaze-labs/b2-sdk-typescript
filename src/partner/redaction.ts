import { B2PartnerAuthorizationError } from '../errors/index.ts'
import type {
  CreateGroupMemberResponse,
  CreateGroupMemberResult,
  PartnerAuthorizeResponse,
  ReserveTrialCreateAccountResponse,
  ReserveTrialCreateAccountResult,
} from '../types/partner.ts'

/** Placeholder used when a Partner token is serialized for logs or inspection. */
export const PARTNER_TOKEN_REDACTED = '[redacted Partner token]'
/** Placeholder used when an application key secret is serialized for logs or inspection. */
export const APPLICATION_KEY_REDACTED = '[redacted application key]'

/**
 * JSON-safe Partner authorize response with the Partner token replaced by a
 * placeholder string.
 */
export interface RedactedPartnerAuthorizeResponseJson
  extends Omit<PartnerAuthorizeResponse, 'authorizationToken'> {
  /** Redacted Partner authorization token placeholder. */
  readonly authorizationToken: string
}

export type RedactedCreateGroupMemberResultJson = Omit<
  CreateGroupMemberResult,
  'applicationKey'
> & {
  readonly applicationKey: string
}

export type RedactedCreateGroupMemberResponseJson = readonly RedactedCreateGroupMemberResultJson[]

export type RedactedReserveTrialCreateAccountResultJson = Omit<
  ReserveTrialCreateAccountResult,
  'applicationKey'
> & {
  readonly applicationKey: string
}

export type RedactedReserveTrialCreateAccountResponseJson =
  readonly RedactedReserveTrialCreateAccountResultJson[]

const inspectSymbol = Symbol.for('nodejs.util.inspect.custom')

// Bun/WebKit only honor object toJSON hooks when they are inherited, while Node
// honors own hooks. Install both shapes so SDK safe serialization is portable.
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

/**
 * Returns a redacted copy for log serializers that intentionally hide tokens.
 *
 * @param auth - Partner authorization response to render safely.
 *
 * @returns A plain object with the Partner token replaced by a placeholder.
 */
export function partnerAuthorizeResponseToRedactedJson(
  auth: PartnerAuthorizeResponse,
): RedactedPartnerAuthorizeResponseJson {
  return {
    ...auth,
    authorizationToken: PARTNER_TOKEN_REDACTED,
  }
}

/**
 * Returns a plain Partner authorize response copy for trusted auth-cache persistence.
 *
 * Unlike `JSON.stringify(auth)`, this preserves `authorizationToken` so the
 * result can be stringified, stored securely, parsed, and passed back to
 * `PartnerAccountInfo.setAuth()`. Do not log this output.
 *
 * @param auth - Partner authorization response to persist.
 *
 * @returns A plain object with the live Partner token preserved.
 */
export function partnerAuthorizeResponseToPersistableJson(
  auth: PartnerAuthorizeResponse,
): PartnerAuthorizeResponse {
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
            },
          }
        : {}),
      ...(backupApi !== undefined
        ? {
            backupApi: {
              ...backupApi,
              capabilities: [...backupApi.capabilities],
            },
          }
        : {}),
    },
    ...(auth.groupsApiUrl !== undefined ? { groupsApiUrl: auth.groupsApiUrl } : {}),
    ...(auth.backupApiUrl !== undefined ? { backupApiUrl: auth.backupApiUrl } : {}),
    ...(auth.groupsCapabilities !== undefined
      ? { groupsCapabilities: [...auth.groupsCapabilities] }
      : {}),
    ...(auth.backupCapabilities !== undefined
      ? { backupCapabilities: [...auth.backupCapabilities] }
      : {}),
    applicationKeyExpirationTimestamp: auth.applicationKeyExpirationTimestamp,
  }
}

/**
 * Returns a redacted copy for log serializers that intentionally hide group-member keys.
 *
 * @param result - Create group member result to render safely.
 *
 * @returns A plain object with the application key secret replaced by a placeholder.
 */
export function createGroupMemberResultToRedactedJson(
  result: CreateGroupMemberResult,
): RedactedCreateGroupMemberResultJson {
  return {
    ...result,
    applicationKey: APPLICATION_KEY_REDACTED,
  }
}

/**
 * Returns a redacted copy for log serializers that intentionally hide group-member keys.
 *
 * @param response - Create group member response to render safely.
 *
 * @returns A plain array with every application key secret replaced by a placeholder.
 */
export function createGroupMemberResponseToRedactedJson(
  response: CreateGroupMemberResponse,
): RedactedCreateGroupMemberResponseJson {
  return response.map((result) => createGroupMemberResultToRedactedJson(result))
}

/**
 * Returns a redacted copy for log serializers that intentionally hide trial account keys.
 *
 * @param result - Reserve trial account result to render safely.
 *
 * @returns A plain object with the application key secret replaced by a placeholder.
 */
export function reserveTrialCreateAccountResultToRedactedJson(
  result: ReserveTrialCreateAccountResult,
): RedactedReserveTrialCreateAccountResultJson {
  return {
    ...result,
    applicationKey: APPLICATION_KEY_REDACTED,
  }
}

/**
 * Returns a redacted copy for log serializers that intentionally hide trial account keys.
 *
 * @param response - Reserve trial account response to render safely.
 *
 * @returns A plain array with every application key secret replaced by a placeholder.
 */
export function reserveTrialCreateAccountResponseToRedactedJson(
  response: ReserveTrialCreateAccountResponse,
): RedactedReserveTrialCreateAccountResponseJson {
  return response.map((result) => reserveTrialCreateAccountResultToRedactedJson(result))
}

/**
 * Adds non-enumerable serialization and inspection hooks that redact the
 * Partner token through `JSON.stringify`, `toString`, and Node `util.inspect`
 * while preserving direct property access.
 *
 * `JSON.stringify` no longer round-trips `authorizationToken` from protected
 * authorize responses. Persist trusted auth caches with
 * {@link partnerAuthorizeResponseToPersistableJson} before JSON serialization, or
 * read `authorizationToken` directly into secure storage before serializing.
 *
 * This does not make the object universally log-safe: object spread,
 * `Object.assign`, `Object.entries`, `structuredClone`, and serializers that
 * walk enumerable properties can still expose the raw token.
 *
 * @param auth - Partner authorization response to protect from accidental inspection.
 *
 * @returns The same auth object with inspection hooks installed when possible.
 */
export function redactPartnerAuthorizeResponse(
  auth: PartnerAuthorizeResponse,
): PartnerAuthorizeResponse {
  const target = Object.isExtensible(auth) ? auth : { ...auth }
  const toRedactedJson = (): RedactedPartnerAuthorizeResponseJson =>
    partnerAuthorizeResponseToRedactedJson(target)
  const toRedactedString = (): string => `[PartnerAuthorizeResponse ${PARTNER_TOKEN_REDACTED}]`

  installPortableJsonHook(target, toRedactedJson)
  Object.defineProperties(target, {
    toString: {
      value: toRedactedString,
      enumerable: false,
      configurable: true,
    },
    [inspectSymbol]: {
      value: toRedactedJson,
      enumerable: false,
      configurable: true,
    },
  })

  return target
}

/**
 * Adds non-enumerable serialization and inspection hooks that redact the
 * application key secret while preserving direct property access.
 *
 * @param result - Create group member result to protect from accidental logging.
 *
 * @returns The same result object with redaction hooks installed when possible.
 */
export function redactCreateGroupMemberResult(
  result: CreateGroupMemberResult,
): CreateGroupMemberResult {
  const target = Object.isExtensible(result) ? result : { ...result }
  const toRedactedJson = (): RedactedCreateGroupMemberResultJson =>
    createGroupMemberResultToRedactedJson(target)
  const toRedactedString = (): string => `[CreateGroupMemberResult ${APPLICATION_KEY_REDACTED}]`

  installPortableJsonHook(target, toRedactedJson)
  Object.defineProperties(target, {
    toString: {
      value: toRedactedString,
      enumerable: false,
      configurable: true,
    },
    [inspectSymbol]: {
      value: toRedactedJson,
      enumerable: false,
      configurable: true,
    },
  })

  return target
}

/**
 * Adds non-enumerable serialization and inspection hooks that redact all
 * create-group-member application key secrets while preserving direct access.
 *
 * @param response - Create group member response to protect from accidental logging.
 *
 * @returns The same response array with redaction hooks installed when possible.
 *
 * @throws B2PartnerAuthorizationError if the response is not an array.
 */
export function redactCreateGroupMemberResponse(
  response: CreateGroupMemberResponse,
): CreateGroupMemberResponse {
  if (!Array.isArray(response)) {
    throw new B2PartnerAuthorizationError('b2_create_group_member response was not a JSON array')
  }

  const target = Object.isExtensible(response) ? response : [...response]
  const writableTarget = target as CreateGroupMemberResult[]
  for (let i = 0; i < writableTarget.length; i++) {
    const result = writableTarget[i]
    if (result !== undefined) writableTarget[i] = redactCreateGroupMemberResult(result)
  }

  const toRedactedJson = (): RedactedCreateGroupMemberResponseJson =>
    createGroupMemberResponseToRedactedJson(target)
  const toRedactedString = (): string => `[CreateGroupMemberResponse ${APPLICATION_KEY_REDACTED}]`

  Object.defineProperties(target, {
    toJSON: {
      value: toRedactedJson,
      enumerable: false,
      configurable: true,
    },
    toString: {
      value: toRedactedString,
      enumerable: false,
      configurable: true,
    },
    [inspectSymbol]: {
      value: toRedactedJson,
      enumerable: false,
      configurable: true,
    },
  })

  return target
}

/**
 * Adds non-enumerable serialization and inspection hooks that redact the
 * application key secret while preserving direct property access.
 *
 * `JSON.stringify` redacts because the response contains newly minted
 * application key secrets that are commonly logged as batch results. Callers
 * that need to persist the key should read `applicationKey` directly into
 * secure storage before serializing the object.
 *
 * @param result - Reserve trial account result to protect from accidental logging.
 *
 * @returns The same result object with redaction hooks installed when possible.
 */
export function redactReserveTrialCreateAccountResult(
  result: ReserveTrialCreateAccountResult,
): ReserveTrialCreateAccountResult {
  const target = Object.isExtensible(result) ? result : { ...result }
  const toRedactedJson = (): RedactedReserveTrialCreateAccountResultJson =>
    reserveTrialCreateAccountResultToRedactedJson(target)
  const toRedactedString = (): string =>
    `[ReserveTrialCreateAccountResult ${APPLICATION_KEY_REDACTED}]`

  installPortableJsonHook(target, toRedactedJson)
  Object.defineProperties(target, {
    toString: {
      value: toRedactedString,
      enumerable: false,
      configurable: true,
    },
    [inspectSymbol]: {
      value: toRedactedJson,
      enumerable: false,
      configurable: true,
    },
  })

  return target
}

/**
 * Adds non-enumerable serialization and inspection hooks that redact all
 * reserve-trial application key secrets while preserving direct property access.
 *
 * @param response - Reserve trial account response to protect from accidental logging.
 *
 * @returns The same response array with redaction hooks installed when possible.
 *
 * @throws B2PartnerAuthorizationError if the response is not an array.
 */
export function redactReserveTrialCreateAccountResponse(
  response: ReserveTrialCreateAccountResponse,
): ReserveTrialCreateAccountResponse {
  if (!Array.isArray(response)) {
    throw new B2PartnerAuthorizationError(
      'b2_reserve_trial_create_account response was not a JSON array',
    )
  }

  const target = Object.isExtensible(response) ? response : [...response]
  const writableTarget = target as ReserveTrialCreateAccountResult[]
  for (let i = 0; i < writableTarget.length; i++) {
    const result = writableTarget[i]
    if (result !== undefined) writableTarget[i] = redactReserveTrialCreateAccountResult(result)
  }

  const toRedactedJson = (): RedactedReserveTrialCreateAccountResponseJson =>
    reserveTrialCreateAccountResponseToRedactedJson(target)
  const toRedactedString = (): string =>
    `[ReserveTrialCreateAccountResponse ${APPLICATION_KEY_REDACTED}]`

  Object.defineProperties(target, {
    toJSON: {
      value: toRedactedJson,
      enumerable: false,
      configurable: true,
    },
    toString: {
      value: toRedactedString,
      enumerable: false,
      configurable: true,
    },
    [inspectSymbol]: {
      value: toRedactedJson,
      enumerable: false,
      configurable: true,
    },
  })

  return target
}
