import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BucketType } from '../../types/bucket.ts'
import { makeRemoteClient } from '../remote-simulator.ts'
import { processSimulator } from '../remote-simulator-process.ts'

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * One side of the worker-isolation check. Both sides reset, wait for each
 * other, create one bucket each, wait again, then list buckets.
 *
 * @param name - This side's name.
 * @param other - The other side's name.
 */
export function isolationCase(name: string, other: string): void {
  it(`${name} sees only its own bucket`, async () => {
    const dir = process.env['ISOLATION_DIR']
    if (dir === undefined) throw new Error('ISOLATION_DIR is not set')
    const { client, sim } = await makeRemoteClient()
    await client.authorize()
    const server = await processSimulator()
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({ workerPid: process.pid, serverPid: server.pid, controlUrl: sim.controlUrl }),
    )
    await waitForFile(join(dir, `${other}.json`))
    await client.createBucket({
      bucketName: `isolation-${name}`,
      bucketType: BucketType.AllPrivate,
    })
    writeFileSync(join(dir, `${name}.created`), '')
    await waitForFile(join(dir, `${other}.created`))
    const buckets = await client.listBuckets()
    expect(buckets.map((bucket) => bucket.name)).toEqual([`isolation-${name}`])
  })
}
