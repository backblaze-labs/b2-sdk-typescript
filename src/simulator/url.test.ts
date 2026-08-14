import { describe, expect, it } from 'vitest'
import { B2Simulator } from './index.ts'

describe('B2Simulator API URL routing', () => {
  it('routes non-b2api backup paths by their last segment', async () => {
    const sim = new B2Simulator()

    const response = await sim.transport().send({
      url: 'http://localhost:0/api/backup/v1/b2_list_buckets',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'account' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ buckets: [] })
  })

  it('routes backup paths with trailing slashes by their endpoint segment', async () => {
    const sim = new B2Simulator()

    const response = await sim.transport().send({
      url: 'http://localhost:0/api/backup/v1/b2_list_buckets/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'account' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ buckets: [] })
  })

  it('reads the API version from non-b2api paths', async () => {
    const sim = new B2Simulator()

    const response = await sim.transport().send({
      url: 'http://localhost:0/api/backup/v4/b2_create_key',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account',
        capabilities: [],
        keyName: 'key',
        bucketId: 'bucket',
      }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: 'bucketId is not accepted by v4 b2_create_key; use bucketIds',
    })
  })
})
