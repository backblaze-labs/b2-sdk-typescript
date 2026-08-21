import type { Bucket } from '../../src/bucket.ts'

export async function deleteFileVersionOnce(
  b: Bucket,
  fileName: string,
  fileId: Parameters<Bucket['deleteFileVersion']>[1],
  deleted: Set<string>,
  options?: Parameters<Bucket['deleteFileVersion']>[2],
): Promise<void> {
  const key = `${fileName}\0${fileId}`
  if (deleted.has(key)) return
  try {
    await b.deleteFileVersion(fileName, fileId, options)
  } catch (err) {
    if (!hasB2ErrorCode(err, 'file_not_present') && !hasB2ErrorCode(err, 'no_such_file')) {
      throw err
    }
  }
  deleted.add(key)
}

export function hasB2ErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { readonly code?: unknown }).code === code
  )
}
