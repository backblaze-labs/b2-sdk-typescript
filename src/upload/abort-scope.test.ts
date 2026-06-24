import { describe, expect, it } from 'vitest'
import { deferred } from '../test-utils/index.ts'
import { raceWithAbort } from './abort-scope.ts'

describe('raceWithAbort', () => {
  it('throws immediately and observes a pre-aborted request promise', async () => {
    const controller = new AbortController()
    const reason = new Error('already aborted')
    const request = deferred<string>()

    controller.abort(reason)
    const raced = raceWithAbort(request.promise, controller.signal)
    request.reject(new Error('late request failure'))

    await expect(raced).rejects.toBe(reason)
  })
})
