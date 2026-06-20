import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PEER_IMPORTS = ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'] as const

const IMPORT_SPECIFIER_PATTERN = String.raw`(?:from\s+|import\s*\(\s*)['"]PEER['"]`

describe('S3 presign peer dependency boundary', () => {
  it('does not import AWS peer modules from the presign implementation', async () => {
    const directory = dirname(fileURLToPath(import.meta.url))
    const sources = await Promise.all(
      ['index.ts', 'sigv4.ts'].map(async (fileName) => ({
        fileName,
        source: await readFile(join(directory, fileName), 'utf8'),
      })),
    )

    for (const { fileName, source } of sources) {
      for (const peerImport of PEER_IMPORTS) {
        const pattern = new RegExp(
          IMPORT_SPECIFIER_PATTERN.replace('PEER', escapeRegExp(peerImport)),
        )
        expect(source, `${fileName} must not import ${peerImport}`).not.toMatch(pattern)
      }
    }
  })
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
