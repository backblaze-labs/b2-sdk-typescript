/**
 * Node-only assertion: `EncryptionKey` must not leak its key bytes through
 * `util.inspect` (which is what `console.log` calls under the hood in Node).
 *
 * Lives in a separate `*.node.test.ts` file because `node:util` has no
 * browser analogue. The cross-runtime redaction assertions (`toJSON`,
 * `toString`) stay in `streams.test.ts` and run in both Node and browsers.
 */
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { EncryptionKey } from '../types/encryption.ts'

describe('EncryptionKey (Node-only)', () => {
  const rawKey = new Uint8Array(32).fill(0xaa)

  it('Node util.inspect (used by console.log) does not leak the key', async () => {
    const key = await EncryptionKey.fromBytes(rawKey)
    const inspected = inspect(key)
    expect(inspected).not.toContain(key.customerKey)
    expect(inspected).not.toContain(key.customerKeyMd5)
    expect(inspected).toContain('[redacted')
  })
})
