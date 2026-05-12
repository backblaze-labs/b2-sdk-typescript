/** Supported server-side encryption algorithm. Currently only AES-256 is supported. */
export type EncryptionAlgorithm = 'AES256'

/** Server-side encryption mode for files stored in B2. */
export type EncryptionMode = 'SSE-B2' | 'SSE-C' | 'none'

/** Server-side encryption using B2-managed keys (SSE-B2). */
export interface SseB2Setting {
  /** Encryption mode discriminator. Always `'SSE-B2'`. */
  readonly mode: 'SSE-B2'
  /** Encryption algorithm. Always `'AES256'`. */
  readonly algorithm: EncryptionAlgorithm
}

/** Server-side encryption using customer-provided keys (SSE-C). */
export interface SseCCustomerSetting {
  /** Encryption mode discriminator. Always `'SSE-C'`. */
  readonly mode: 'SSE-C'
  /** Encryption algorithm. Always `'AES256'`. */
  readonly algorithm: EncryptionAlgorithm
  /** Base64-encoded 256-bit encryption key provided by the customer. */
  readonly customerKey: string
  /** Base64-encoded MD5 digest of the customer-provided key, used for integrity verification. */
  readonly customerKeyMd5: string
}

/** Indicates no server-side encryption is applied. */
export interface NoEncryption {
  /** Encryption mode discriminator. Always `'none'`. */
  readonly mode: 'none'
}

/** Union of all server-side encryption settings: B2-managed, customer-provided, or none. */
export type EncryptionSetting = SseB2Setting | SseCCustomerSetting | NoEncryption

/** Pre-built SSE-B2 encryption setting using AES-256. */
export const SSE_B2: SseB2Setting = { mode: 'SSE-B2', algorithm: 'AES256' }

/** Pre-built setting indicating no server-side encryption. */
export const SSE_NONE: NoEncryption = { mode: 'none' }

/**
 * Creates an SSE-C encryption setting with a customer-provided key.
 * @param customerKey - Base64-encoded 256-bit encryption key.
 * @param customerKeyMd5 - Base64-encoded MD5 digest of the key.
 *
 * @returns An SSE-C encryption setting ready to pass to upload or download calls.
 */
export function sseCustomer(customerKey: string, customerKeyMd5: string): SseCCustomerSetting {
  return { mode: 'SSE-C', algorithm: 'AES256', customerKey, customerKeyMd5 }
}
