/**
 * Pure function: given a B2 client + bucket + file-key + prefix scope,
 * produce a signed download URL valid for `expiresInSeconds`.
 *
 * Separated from the HTTP layer so it can be unit-tested against the
 * in-memory `B2Simulator` without spinning up a real server.
 */

import type { B2Client, Bucket } from '@backblaze/b2-sdk'

/** Result of {@link mintDownloadUrl}: the signed URL and when it expires. */
export interface MintedUrl {
  /** Full URL the client can follow to download the file directly from B2. */
  readonly url: string
  /** UTC milliseconds when the authorization token expires. */
  readonly expiresAt: number
}

/**
 * Mints a B2-signed download URL.
 *
 * @param client - Authorized B2 client.
 * @param bucket - The bucket the file lives in.
 * @param fileKey - Full file name (path) inside the bucket.
 * @param allowedPrefix - The narrowest prefix the caller is entitled to;
 *   the issued token is scoped to this prefix so a leaked token has minimal blast radius.
 * @param expiresInSeconds - Token lifetime; default 60 seconds.
 *
 * @returns The signed URL and its absolute expiry timestamp.
 */
export async function mintDownloadUrl(
  client: B2Client,
  bucket: Bucket,
  fileKey: string,
  allowedPrefix: string,
  expiresInSeconds = 60,
): Promise<MintedUrl> {
  const auth = await bucket.getDownloadAuthorization(allowedPrefix, expiresInSeconds)
  const downloadUrl = client.accountInfo.getDownloadUrl()
  const encodedKey = fileKey
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  const url = `${downloadUrl}/file/${encodeURIComponent(bucket.name)}/${encodedKey}?Authorization=${encodeURIComponent(auth.authorizationToken)}`
  return { url, expiresAt: Date.now() + expiresInSeconds * 1000 }
}
