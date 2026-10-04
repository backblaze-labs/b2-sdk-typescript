/**
 * Boilerplate shared by every Node example: read credentials from env and
 * construct an authorized {@link B2Client}.
 *
 * Examples that import this helper drop ~12 lines of identical setup
 * code each. The business logic stays in the example file itself.
 */

import { B2Client } from '@backblaze-labs/b2-sdk'

/**
 * Reads `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY` from the process
 * environment, constructs a {@link B2Client}, and awaits `authorize()`.
 *
 * On missing credentials, prints a usage hint to stderr and exits the process
 * with code 1.
 *
 * @returns The authorized client.
 */
export async function setupClient(): Promise<B2Client> {
  const keyId = process.env.B2_APPLICATION_KEY_ID
  const key = process.env.B2_APPLICATION_KEY
  if (!keyId || !key) {
    console.error('Set B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY environment variables.')
    process.exit(1)
  }
  const client = new B2Client({
    applicationKeyId: keyId,
    applicationKey: key,
  })
  await client.authorize()
  return client
}
