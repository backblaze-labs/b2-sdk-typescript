export type EncryptionAlgorithm = 'AES256'

export type EncryptionMode = 'SSE-B2' | 'SSE-C' | 'none'

export interface SseB2Setting {
  readonly mode: 'SSE-B2'
  readonly algorithm: EncryptionAlgorithm
}

export interface SseCCustomerSetting {
  readonly mode: 'SSE-C'
  readonly algorithm: EncryptionAlgorithm
  readonly customerKey: string
  readonly customerKeyMd5: string
}

export interface NoEncryption {
  readonly mode: 'none'
}

export type EncryptionSetting = SseB2Setting | SseCCustomerSetting | NoEncryption

export const SSE_B2: SseB2Setting = { mode: 'SSE-B2', algorithm: 'AES256' }
export const SSE_NONE: NoEncryption = { mode: 'none' }

export function sseCustomer(customerKey: string, customerKeyMd5: string): SseCCustomerSetting {
  return { mode: 'SSE-C', algorithm: 'AES256', customerKey, customerKeyMd5 }
}
