import type { PartnerAuthorizeResponse } from '../types/partner.ts'

/** Placeholder used when a Partner token is serialized for logs or inspection. */
export const PARTNER_TOKEN_REDACTED = '[redacted Partner token]'

export type RedactedPartnerAuthorizeResponseJson = Omit<
  PartnerAuthorizeResponse,
  'authorizationToken'
> & {
  readonly authorizationToken: string
}

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
