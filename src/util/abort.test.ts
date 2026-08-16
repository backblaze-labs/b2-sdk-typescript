import { describe, expect, it } from 'vitest'
import { deferred } from '../test-utils/index.ts'
import { raceWithAbort } from './abort.ts'

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

  it('throws when the signal aborts while attaching the listener', async () => {
    const reason = new Error('attach race abort')
    const request = deferred<string>()
    let aborted = false
    const signal = {
      get aborted() {
        return aborted
      },
      get reason() {
        return reason
      },
      addEventListener() {
        aborted = true
      },
      removeEventListener() {},
    } as unknown as AbortSignal

    const raced = raceWithAbort(request.promise, signal)
    request.reject(new Error('late request failure'))

    await expect(raced).rejects.toBe(reason)
  })
})
