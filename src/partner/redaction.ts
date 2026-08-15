import type {
  PartnerAuthorizeResponse,
  ReserveTrialCreateAccountResponse,
  ReserveTrialCreateAccountResult,
} from '../types/partner.ts'

/** Placeholder used when a Partner token is serialized for logs or inspection. */
export const PARTNER_TOKEN_REDACTED = '[redacted Partner token]'
/** Placeholder used when an application key secret is serialized for logs or inspection. */
export const APPLICATION_KEY_REDACTED = '[redacted application key]'

export type RedactedPartnerAuthorizeResponseJson = Omit<
  PartnerAuthorizeResponse,
  'authorizationToken'
> & {
  readonly authorizationToken: string
}

export type RedactedReserveTrialCreateAccountResultJson = Omit<
  ReserveTrialCreateAccountResult,
  'applicationKey'
> & {
  readonly applicationKey: string
}

export type RedactedReserveTrialCreateAccountResponseJson =
  readonly RedactedReserveTrialCreateAccountResultJson[]

const inspectSymbol = Symbol.for('nodejs.util.inspect.custom')

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
 * Adds non-enumerable inspection hooks that redact the Partner token while
 * preserving the plain enumerable data shape for serialization and handoff.
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
 * Adds non-enumerable serialization and inspection hooks that redact all
 * reserve-trial application key secrets while preserving direct property access.
 *
 * @param response - Reserve trial account response to protect from accidental logging.
 *
 * @returns The same response array with redaction hooks installed when possible.
 */
export function redactReserveTrialCreateAccountResponse(
  response: ReserveTrialCreateAccountResponse,
): ReserveTrialCreateAccountResponse {
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
