/**
 * React Native (or browser) helper that uploads a Blob to B2 via a presigned
 * URL obtained from a backend route.
 *
 * Zero dependencies: uses only `fetch` and Web Crypto, both of which are
 * available in modern React Native (Hermes + the built-in WHATWG fetch).
 */

/** What the backend's `/sign` endpoint returns. */
interface SignResponse {
  uploadUrl: string
  authorizationToken: string
  fileName: string
  contentType: string
}

/** Optional progress callback shape. */
export interface UploadProgress {
  loaded: number
  total: number
}

/**
 * Computes the lowercase-hex SHA-1 digest of a Blob using Web Crypto.
 *
 * @param blob - The blob whose contents should be hashed.
 *
 * @returns The 40-character SHA-1 hex digest.
 */
async function sha1Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-1', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Uploads a Blob to B2 by first asking the backend to sign a one-time URL.
 *
 * @param options - Backend URL, the file name to use in the bucket, the Blob, and an optional progress listener.
 *
 * @returns The parsed B2 file-version JSON.
 */
export async function uploadToBackblaze(options: {
  /** Your backend's `/sign` route, e.g. `https://api.example.com/sign`. */
  signEndpoint: string
  /** File name (path) to use in the bucket. */
  fileName: string
  /** The bytes to upload. From `expo-image-picker`, `fetch(uri).then(r => r.blob())`, etc. */
  blob: Blob
  /** Optional auth header to attach to the backend call (e.g. JWT). */
  bearer?: string
  /** Optional progress callback. */
  onProgress?: (p: UploadProgress) => void
}): Promise<{ fileId: string; fileName: string; contentLength: number }> {
  // 1. Hash the file. B2 requires X-Bz-Content-Sha1.
  const sha1 = await sha1Hex(options.blob)

  // 2. Ask the backend for a signed upload URL.
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.bearer) headers['authorization'] = `Bearer ${options.bearer}`
  const signResponse = await fetch(options.signEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fileName: options.fileName, contentType: options.blob.type }),
  })
  if (!signResponse.ok) {
    throw new Error(`sign failed: ${signResponse.status} ${await signResponse.text()}`)
  }
  const signed: SignResponse = await signResponse.json()

  // 3. PUT the bytes to B2 directly.
  const uploadResponse = await fetch(signed.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: signed.authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(signed.fileName),
      'X-Bz-Content-Sha1': sha1,
      'Content-Type': signed.contentType,
      'Content-Length': String(options.blob.size),
    },
    body: options.blob,
  })
  if (!uploadResponse.ok) {
    throw new Error(`upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`)
  }
  return uploadResponse.json()
}
