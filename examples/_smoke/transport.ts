/**
 * Lazy helper that swaps the SDK's default `FetchTransport` for an in-memory
 * `B2Simulator` when `B2_USE_SIMULATOR=1`. Used by CI to run every example
 * end-to-end without hitting real B2 (no credentials, no network, no cost).
 *
 * In production runs (`B2_USE_SIMULATOR` unset or != '1') this returns
 * `undefined` and the SDK uses the real network transport. The example code
 * spreads the result conditionally so production behaviour is unchanged.
 *
 * The simulator is pre-seeded with a bucket named `smoke-test` containing a
 * single file `smoke-test.txt`, so download/list examples have something to
 * read. Examples that create their own state (upload, backup) work too —
 * they just add to the pre-seeded sim.
 */

import { B2Client, BucketType } from '@backblaze-labs/b2-sdk'
import type { HttpTransport } from '@backblaze-labs/b2-sdk'
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
import { BufferSource } from '@backblaze-labs/b2-sdk/streams'

/** Bucket name pre-seeded by {@link smokeTransport} when in simulator mode. */
export const SMOKE_BUCKET = 'smoke-test'
/** File name pre-seeded inside {@link SMOKE_BUCKET}. */
export const SMOKE_FILE = 'smoke-test.txt'
/** Plaintext contents of {@link SMOKE_FILE}. */
export const SMOKE_BODY = 'hello smoke\n'

/**
 * Returns a custom `HttpTransport` backed by an in-memory `B2Simulator` if
 * `B2_USE_SIMULATOR=1`, or `undefined` for real B2. Idempotent across a
 * single process — but each Node process gets its own fresh simulator.
 *
 * @returns A simulator transport (CI smoke mode) or `undefined` (production).
 */
export async function smokeTransport(): Promise<HttpTransport | undefined> {
  if (process.env.B2_USE_SIMULATOR !== '1') return undefined

  const sim = new B2Simulator()
  // Use a throwaway client just for seeding state.
  const setup = new B2Client({
    applicationKeyId: 'smoke-key',
    applicationKey: 'smoke-secret',
    transport: sim.transport(),
  })
  await setup.authorize()
  const bucket = await setup.createBucket({
    bucketName: SMOKE_BUCKET,
    bucketType: BucketType.AllPrivate,
  })
  await bucket.upload({
    fileName: SMOKE_FILE,
    source: new BufferSource(new TextEncoder().encode(SMOKE_BODY)),
    contentType: 'text/plain',
  })

  return sim.transport()
}
