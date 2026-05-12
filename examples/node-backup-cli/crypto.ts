/**
 * Client-side encryption for the backup CLI.
 *
 * Design:
 *   - Master KEK derived from passphrase via PBKDF2-SHA-256, 600,000 iterations
 *     (OWASP 2024 guidance), 32-byte output. The salt is generated once per
 *     repository and stored alongside the manifest.
 *   - Each file gets a fresh 32-byte random DEK and a 12-byte random IV.
 *   - The file bytes are encrypted with AES-256-GCM (authenticated; the 16-byte
 *     tag is appended to the ciphertext by Web Crypto automatically).
 *   - The DEK is wrapped with AES-GCM under the KEK (separate 12-byte IV), and
 *     the wrapped DEK + the file IV are stored as B2 `fileInfo` so they travel
 *     with the ciphertext. B2 never sees the plaintext key.
 *
 * The KEK never leaves memory. Losing the passphrase means losing the data.
 */

const PBKDF2_ITERATIONS = 600_000
const SALT_BYTES = 16
const DEK_BYTES = 32
const IV_BYTES = 12

/** Wrapped DEK + IV pair that travels alongside the ciphertext as B2 fileInfo. */
export interface WrappedKey {
  /** Base64url-encoded wrapped DEK (ciphertext + GCM tag). */
  readonly wrappedDek: string
  /** Base64url-encoded IV used to wrap the DEK. */
  readonly wrapIv: string
  /** Base64url-encoded IV used to encrypt the file bytes. */
  readonly fileIv: string
}

/** Encode bytes to URL-safe base64 (no padding). */
function b64u(bytes: Uint8Array<ArrayBuffer>): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode URL-safe base64 (with or without padding) to bytes. */
function b64uDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(std)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Generate a fresh random salt for a new backup repository.
 *
 * @returns 16 bytes of cryptographically secure randomness.
 */
export function generateSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES))
}

/**
 * Derive a master KEK from a passphrase + salt. Returns a non-extractable
 * CryptoKey suitable only for AES-GCM wrap/unwrap.
 *
 * @param passphrase - User-supplied secret. Whitespace is NOT trimmed.
 * @param salt - Per-repository salt from {@link generateSalt}.
 *
 * @returns A CryptoKey usable only for wrapping/unwrapping per-file DEKs.
 */
export async function deriveKek(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const passKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    passKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

/**
 * Encrypt one file's plaintext with a fresh random DEK, then wrap the DEK
 * under the supplied KEK.
 *
 * @param plaintext - The bytes to encrypt.
 * @param kek - Master KEK from {@link deriveKek}.
 *
 * @returns The ciphertext (with appended GCM tag) and the wrapped-key metadata.
 */
export async function encryptFile(
  plaintext: Uint8Array<ArrayBuffer>,
  kek: CryptoKey,
): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; wrapped: WrappedKey }> {
  const dekRaw = crypto.getRandomValues(new Uint8Array(DEK_BYTES))
  const fileIv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTES))

  const dek = await crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ])

  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fileIv }, dek, plaintext)
  const wrappedBuf = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv: wrapIv })

  return {
    ciphertext: new Uint8Array(ctBuf),
    wrapped: {
      wrappedDek: b64u(new Uint8Array(wrappedBuf)),
      wrapIv: b64u(wrapIv),
      fileIv: b64u(fileIv),
    },
  }
}

/**
 * Reverse of {@link encryptFile}: unwrap the per-file DEK with the master KEK
 * and decrypt the ciphertext.
 *
 * @param ciphertext - The ciphertext (with appended GCM tag).
 * @param wrapped - The wrapped-key metadata stored as B2 fileInfo.
 * @param kek - Master KEK from {@link deriveKek}.
 *
 * @returns The decrypted plaintext.
 *
 * @throws If the ciphertext was tampered with or the passphrase is wrong
 * (manifested as an AES-GCM authentication failure).
 */
export async function decryptFile(
  ciphertext: Uint8Array<ArrayBuffer>,
  wrapped: WrappedKey,
  kek: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const wrapIv = b64uDecode(wrapped.wrapIv)
  const fileIv = b64uDecode(wrapped.fileIv)
  const wrappedDek = b64uDecode(wrapped.wrappedDek)

  const dek = await crypto.subtle.unwrapKey(
    'raw',
    wrappedDek,
    kek,
    { name: 'AES-GCM', iv: wrapIv },
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fileIv }, dek, ciphertext)
  return new Uint8Array(ptBuf)
}

/** Serialize a salt for storage in the manifest. */
export function saltToString(salt: Uint8Array<ArrayBuffer>): string {
  return b64u(salt)
}

/** Parse a salt previously serialized by {@link saltToString}. */
export function saltFromString(s: string): Uint8Array<ArrayBuffer> {
  return b64uDecode(s)
}
