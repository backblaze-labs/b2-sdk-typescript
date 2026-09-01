import { B2PartnerAuthorizationError } from '../errors/index.ts'
import type {
  CreateGroupMemberResponse,
  CreateGroupMemberResult,
  PartnerApiInfo,
  PartnerAuthorizeResponse,
  PartnerBackupApiInfo,
  PartnerGroupMember,
  PartnerGroupsApiInfo,
  PartnerStorageApiInfo,
  ReserveTrialCreateAccountResponse,
  ReserveTrialCreateAccountResult,
} from '../types/partner.ts'
import { APPLICATION_KEY_REDACTED, PARTNER_TOKEN_REDACTED } from './redaction-placeholders.ts'

export {
  APPLICATION_KEY_REDACTED,
  PARTNER_TOKEN_REDACTED,
} from './redaction-placeholders.ts'

/**
 * JSON-safe Partner authorize response with the Partner token replaced by a
 * placeholder string.
 */
export interface RedactedPartnerAuthorizeResponseJson
  extends Omit<PartnerAuthorizeResponse, 'authorizationToken'> {
  /** Redacted Partner authorization token placeholder. */
  readonly authorizationToken: string
}

/**
 * JSON-safe create-group-member result with the one-time application key
 * secret replaced by a placeholder string.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export type RedactedCreateGroupMemberResultJson = Omit<
  CreateGroupMemberResult,
  'applicationKey'
> & {
  /** Redacted application key secret placeholder. */
  readonly applicationKey: string
}

/**
 * JSON-safe create-group-member response with the one-time application key
 * secret replaced by a placeholder string.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export type RedactedCreateGroupMemberResponseJson = RedactedCreateGroupMemberResultJson

/**
 * JSON-safe reserve-trial account result with the one-time application key
 * secret replaced by a placeholder string.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export type RedactedReserveTrialCreateAccountResultJson = Omit<
  ReserveTrialCreateAccountResult,
  'applicationKey'
> & {
  /** Redacted application key secret placeholder. */
  readonly applicationKey: string
}

/**
 * JSON-safe reserve-trial account response with the one-time application key
 * secret replaced by a placeholder string.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export type RedactedReserveTrialCreateAccountResponseJson =
  RedactedReserveTrialCreateAccountResultJson

const inspectSymbol = Symbol.for('nodejs.util.inspect.custom')

type Writable<T> = { -readonly [K in keyof T]: T[K] }

function partnerGroupsApiInfoToRedactedJson(info: PartnerGroupsApiInfo): PartnerGroupsApiInfo {
  return {
    capabilities: [...info.capabilities],
    groupsApiUrl: info.groupsApiUrl,
    infoType: info.infoType,
  }
}

function partnerBackupApiInfoToRedactedJson(info: PartnerBackupApiInfo): PartnerBackupApiInfo {
  return {
    capabilities: [...info.capabilities],
    backupApiUrl: info.backupApiUrl,
    infoType: info.infoType,
  }
}

function partnerStorageApiInfoToRedactedJson(info: PartnerStorageApiInfo): PartnerStorageApiInfo {
  return {
    absoluteMinimumPartSize: info.absoluteMinimumPartSize,
    apiUrl: info.apiUrl,
    bucketId: info.bucketId,
    bucketName: info.bucketName,
    capabilities: [...info.capabilities],
    downloadUrl: info.downloadUrl,
    infoType: info.infoType,
    namePrefix: info.namePrefix,
    recommendedPartSize: info.recommendedPartSize,
    s3ApiUrl: info.s3ApiUrl,
  }
}

function partnerApiInfoToRedactedJson(apiInfo: PartnerApiInfo): PartnerApiInfo {
  const redacted: Writable<PartnerApiInfo> = {}
  if (apiInfo.storageApi !== undefined) {
    redacted.storageApi = partnerStorageApiInfoToRedactedJson(apiInfo.storageApi)
  }
  if (apiInfo.groupsApi !== undefined) {
    redacted.groupsApi = partnerGroupsApiInfoToRedactedJson(apiInfo.groupsApi)
  }
  if (apiInfo.backupApi !== undefined) {
    redacted.backupApi = partnerBackupApiInfoToRedactedJson(apiInfo.backupApi)
  }
  return redacted
}

function partnerGroupMemberToRedactedJson(groupMember: PartnerGroupMember): PartnerGroupMember {
  return {
    accountId: groupMember.accountId,
    email: groupMember.email,
    groupId: groupMember.groupId,
    groupName: groupMember.groupName,
    region: groupMember.region,
    s3Endpoint: groupMember.s3Endpoint,
  }
}

function isSingleJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The one invariant a create/reserve redaction wrapper must never violate: a
// usable one-time credential must survive. B2 mints the application key exactly
// once, after the (non-deletable) account already exists, so throwing the
// response away over an unexpected *non-credential* field would destroy an
// unrecoverable secret — the core hazard of #280. We hard-fail only when there
// is no usable credential to preserve (nothing is lost in that case).
function isCredentialBearing(
  response: unknown,
): response is { applicationKey: string; applicationKeyId: string } {
  return (
    isSingleJsonObject(response) &&
    typeof response['applicationKey'] === 'string' &&
    typeof response['applicationKeyId'] === 'string'
  )
}

// True when `groupMember` matches every documented field type, so the
// field-specific (allowlist) redaction copies the full shape without dropping
// unexpected fields. A partial/variant object falls back to shallow redaction.
function matchesGroupMemberShape(groupMember: unknown): groupMember is PartnerGroupMember {
  return (
    isSingleJsonObject(groupMember) &&
    typeof groupMember['accountId'] === 'string' &&
    typeof groupMember['email'] === 'string' &&
    typeof groupMember['groupId'] === 'string' &&
    typeof groupMember['groupName'] === 'string' &&
    typeof groupMember['region'] === 'string' &&
    typeof groupMember['s3Endpoint'] === 'string'
  )
}

// True when the reserve-trial response also matches every documented
// non-credential field, so the field-specific (allowlist) redaction is exact.
function matchesReserveTrialAccountShape(response: ReserveTrialCreateAccountResponse): boolean {
  return (
    typeof response.accountId === 'string' &&
    typeof response.s3Endpoint === 'string' &&
    typeof response.startDate === 'string' &&
    typeof response.endDate === 'string' &&
    typeof response.email === 'string' &&
    typeof response.bucketName === 'string' &&
    typeof response.bucketId === 'string'
  )
}

// Redaction hook for a credential-bearing response whose surrounding shape is
// unexpected: shallow-copy every field the server sent and redact only the
// one-time secret, so the response is never discarded and never logs the key.
function redactApplicationKeyShallow<T extends object>(target: T): unknown {
  return { ...target, applicationKey: APPLICATION_KEY_REDACTED }
}

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

function redactWithHooks<T extends object>(
  value: T,
  toRedactedJsonForTarget: (target: T) => unknown,
  toRedactedString: () => string,
): T {
  const target = Object.isExtensible(value) ? value : ({ ...value } as T)
  const toRedactedJson = (): unknown => toRedactedJsonForTarget(target)

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
 * Returns a redacted copy for log serializers that intentionally hide tokens.
 *
 * @param auth - Partner authorization response to render safely.
 *
 * @returns A plain object with the Partner token replaced by a placeholder.
 */
export function partnerAuthorizeResponseToRedactedJson(
  auth: PartnerAuthorizeResponse,
): RedactedPartnerAuthorizeResponseJson {
  const redacted: Writable<RedactedPartnerAuthorizeResponseJson> = {
    accountId: auth.accountId,
    authorizationToken: PARTNER_TOKEN_REDACTED,
    apiInfo: partnerApiInfoToRedactedJson(auth.apiInfo),
    applicationKeyExpirationTimestamp: auth.applicationKeyExpirationTimestamp,
  }
  if (auth.groupsApiUrl !== undefined) redacted.groupsApiUrl = auth.groupsApiUrl
  if (auth.backupApiUrl !== undefined) redacted.backupApiUrl = auth.backupApiUrl
  if (auth.groupsCapabilities !== undefined) {
    redacted.groupsCapabilities = [...auth.groupsCapabilities]
  }
  if (auth.backupCapabilities !== undefined) {
    redacted.backupCapabilities = [...auth.backupCapabilities]
  }
  return redacted
}

/**
 * Returns a redacted copy for log serializers that intentionally hide group-member keys.
 *
 * @param result - Create group member result to render safely.
 *
 * @returns A plain object with the application key secret replaced by a placeholder.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export function createGroupMemberResultToRedactedJson(
  result: CreateGroupMemberResult,
): RedactedCreateGroupMemberResultJson {
  return {
    applicationKeyId: result.applicationKeyId,
    applicationKey: APPLICATION_KEY_REDACTED,
    groupMember: partnerGroupMemberToRedactedJson(result.groupMember),
  }
}

/**
 * Returns a redacted copy for log serializers that intentionally hide group-member keys.
 *
 * @param response - Create group member response to render safely.
 *
 * @returns A plain object with the application key secret replaced by a placeholder.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export function createGroupMemberResponseToRedactedJson(
  response: CreateGroupMemberResponse,
): RedactedCreateGroupMemberResponseJson {
  return createGroupMemberResultToRedactedJson(response)
}

/**
 * Returns a redacted copy for log serializers that intentionally hide trial account keys.
 *
 * @param result - Reserve trial account result to render safely.
 *
 * @returns A plain object with the application key secret replaced by a placeholder.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export function reserveTrialCreateAccountResultToRedactedJson(
  result: ReserveTrialCreateAccountResult,
): RedactedReserveTrialCreateAccountResultJson {
  return {
    accountId: result.accountId,
    applicationKey: APPLICATION_KEY_REDACTED,
    applicationKeyId: result.applicationKeyId,
    s3Endpoint: result.s3Endpoint,
    startDate: result.startDate,
    endDate: result.endDate,
    email: result.email,
    bucketName: result.bucketName,
    bucketId: result.bucketId,
  }
}

/**
 * Returns a redacted copy for log serializers that intentionally hide trial account keys.
 *
 * @param response - Reserve trial account response to render safely.
 *
 * @returns A plain object with the application key secret replaced by a placeholder.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export function reserveTrialCreateAccountResponseToRedactedJson(
  response: ReserveTrialCreateAccountResponse,
): RedactedReserveTrialCreateAccountResponseJson {
  return reserveTrialCreateAccountResultToRedactedJson(response)
}

/**
 * Adds non-enumerable serialization and inspection hooks that redact the
 * Partner token through `JSON.stringify`, `toString`, and Node `util.inspect`
 * while preserving direct property access.
 *
 * `JSON.stringify` no longer round-trips `authorizationToken` from protected
 * authorize responses. Persist trusted auth caches with
 * `partnerAuthorizeResponseForPersistence(auth)` only into encrypted or
 * otherwise credential-grade storage, or read `authorizationToken` directly
 * into secure storage before serializing.
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
  return redactWithHooks(
    result,
    createGroupMemberResultToRedactedJson,
    () => `[CreateGroupMemberResult ${APPLICATION_KEY_REDACTED}]`,
  )
}

/**
 * Adds non-enumerable serialization and inspection hooks that redact the
 * create-group-member application key secret while preserving direct access.
 *
 * @param response - Create group member response to protect from accidental logging.
 *
 * @returns The same response object with redaction hooks installed when possible.
 *
 * @throws B2PartnerAuthorizationError if the response carries no usable application key.
 */
export function redactCreateGroupMemberResponse(
  response: CreateGroupMemberResponse,
): CreateGroupMemberResponse {
  if (!isCredentialBearing(response)) {
    throw new B2PartnerAuthorizationError(
      'b2_create_group_member response did not contain a usable application key',
    )
  }
  // Full documented shape → field-specific (allowlist) redaction.
  if (matchesGroupMemberShape(response.groupMember)) {
    return redactCreateGroupMemberResult(response)
  }
  // Credential present but the surrounding shape is unexpected: never discard a
  // provisioned one-time key. Return it with only the secret redacted for logs.
  return redactWithHooks(
    response,
    redactApplicationKeyShallow,
    () => `[CreateGroupMemberResponse ${APPLICATION_KEY_REDACTED}]`,
  )
}

/**
 * Adds non-enumerable serialization and inspection hooks that redact the
 * application key secret while preserving direct property access.
 *
 * `JSON.stringify` redacts because the response contains newly minted
 * application key secrets that are commonly logged with responses. Callers
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
  return redactWithHooks(
    result,
    reserveTrialCreateAccountResultToRedactedJson,
    () => `[ReserveTrialCreateAccountResult ${APPLICATION_KEY_REDACTED}]`,
  )
}

/**
 * Adds non-enumerable serialization and inspection hooks that redact the
 * reserve-trial application key secret while preserving direct property access.
 *
 * @param response - Reserve trial account response to protect from accidental logging.
 *
 * @returns The same response object with redaction hooks installed when possible.
 *
 * @throws B2PartnerAuthorizationError if the response carries no usable application key.
 */
export function redactReserveTrialCreateAccountResponse(
  response: ReserveTrialCreateAccountResponse,
): ReserveTrialCreateAccountResponse {
  if (!isCredentialBearing(response)) {
    throw new B2PartnerAuthorizationError(
      'b2_reserve_trial_create_account response did not contain a usable application key',
    )
  }
  // Full documented shape → field-specific (allowlist) redaction.
  if (matchesReserveTrialAccountShape(response)) {
    return redactReserveTrialCreateAccountResult(response)
  }
  // Credential present but the surrounding shape is unexpected: never discard a
  // provisioned one-time key. Return it with only the secret redacted for logs.
  return redactWithHooks(
    response,
    redactApplicationKeyShallow,
    () => `[ReserveTrialCreateAccountResponse ${APPLICATION_KEY_REDACTED}]`,
  )
}
