import type { PartnerAuthorizeResponse } from '../types/partner.ts'

/** Placeholder used when a Partner token is serialized for logs or inspection. */
export const PARTNER_TOKEN_REDACTED = '[redacted Partner token]'

type RedactedPartnerAuthorizeResponseJson = Omit<PartnerAuthorizeResponse, 'authorizationToken'> & {
  readonly authorizationToken: string
}

const inspectSymbol = Symbol.for('nodejs.util.inspect.custom')

/**
 * Adds non-enumerable serialization hooks that redact the Partner token.
 *
 * @param auth - Partner authorization response to protect from accidental logging.
 *
 * @returns The same auth object with redaction hooks installed when possible.
 */
export function redactPartnerAuthorizeResponse(
  auth: PartnerAuthorizeResponse,
): PartnerAuthorizeResponse {
  const target = Object.isExtensible(auth) ? auth : { ...auth }
  const toJSON = (): RedactedPartnerAuthorizeResponseJson => ({
    ...target,
    authorizationToken: PARTNER_TOKEN_REDACTED,
  })
  const toRedactedString = (): string => `[PartnerAuthorizeResponse ${PARTNER_TOKEN_REDACTED}]`

  Object.defineProperties(target, {
    authorizationToken: {
      value: target.authorizationToken,
      enumerable: false,
      configurable: true,
    },
    toJSON: {
      value: toJSON,
      enumerable: false,
      configurable: true,
    },
    toString: {
      value: toRedactedString,
      enumerable: false,
      configurable: true,
    },
    [inspectSymbol]: {
      value: toJSON,
      enumerable: false,
      configurable: true,
    },
  })

  return target
}
