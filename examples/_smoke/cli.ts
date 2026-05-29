/**
 * Boilerplate shared by every Node example: read credentials from env,
 * wire up the smoke-transport (in-memory simulator when `B2_USE_SIMULATOR=1`,
 * real network otherwise), construct an authorized {@link B2Client}.
 *
 * Examples that import this helper drop ~12 lines of identical setup
 * code each. The business logic stays in the example file itself.
 */

import type { HttpTransport } from '@backblaze-labs/b2-sdk'
import { B2Client } from '@backblaze-labs/b2-sdk'
import { smokeTransport } from './transport.ts'

/**
 * Reads `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY` from the process
 * environment, constructs a {@link B2Client}, and awaits `authorize()`.
 *
 * When `B2_USE_SIMULATOR=1` is set, the client is wired to an in-memory
 * {@link B2Simulator} via {@link smokeTransport} so the example runs
 * end-to-end without network access or B2 credentials. Otherwise the
 * default `FetchTransport` is used and real credentials are required.
 *
 * On missing credentials (and no simulator override), prints a usage hint
 * to stderr and exits the process with code 1.
 *
 * @returns The authorized client. The associated transport (if any) is
 *   left implicit — callers don't normally need it, but those that do
 *   can still call {@link smokeTransport} directly.
 */
export async function setupClient(): Promise<B2Client> {
  const keyId = process.env.B2_APPLICATION_KEY_ID
  const key = process.env.B2_APPLICATION_KEY
  const transport: HttpTransport | undefined = await smokeTransport()
  // In simulator mode the credentials are not actually validated, so
  // missing env-vars are tolerated. In real-network mode they are
  // required and a clear hint beats a cryptic 401.
  if ((!keyId || !key) && transport === undefined) {
    console.error('Set B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY environment variables.')
    console.error('(Or run with B2_USE_SIMULATOR=1 to skip credentials.)')
    process.exit(1)
  }
  const client = new B2Client({
    applicationKeyId: keyId ?? 'simulator-key-id',
    applicationKey: key ?? 'simulator-key',
    ...(transport !== undefined ? { transport } : {}),
  })
  await client.authorize()
  return client
}
