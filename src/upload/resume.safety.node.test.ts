/**
 * Audit-derived regression test: the SDK's multipart-resume implementation
 * must NOT write resume state to the local disk.
 *
 * Ecosystem lesson 4: of the two npm B2 backup tools that ship multipart
 * resume with on-disk state, `s3up` writes its `.s3up-state` file in plaintext
 * including the uploadId and the SHA-1 of every uploaded part. That leaks
 * recoverable information if the local disk is shared, backed up, or sniffed.
 *
 * Our `src/upload/resume.ts` uses B2's *server-side* unfinished-large-files
 * listing (`b2_list_unfinished_large_files` + `b2_list_parts`) — no local
 * state at all. This test pins that property down: if a future refactor
 * starts caching resume state in `node:fs`, this test fails immediately.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RESUME_SRC = join(import.meta.dirname, 'resume.ts')

describe('resume state safety (audit lesson 4)', () => {
  it('src/upload/resume.ts does not import any node:fs* APIs', () => {
    const source = readFileSync(RESUME_SRC, 'utf8')
    // Reject anything that pulls in node:fs (or fs/promises) at the
    // top-level. Dynamic imports of fs/promises are equally rejected — there
    // is no legitimate reason for the resume module to touch the local disk.
    expect(source).not.toMatch(/from\s+['"]node:fs/)
    expect(source).not.toMatch(/import\s*\(\s*['"]node:fs/)
  })

  it('src/upload/resume.ts contains the server-side resume primitives', () => {
    const source = readFileSync(RESUME_SRC, 'utf8')
    // Positive control: the module IS doing resume, just via the B2 API.
    expect(source).toMatch(/listUnfinishedLargeFiles/)
    expect(source).toMatch(/listParts/)
  })
})
