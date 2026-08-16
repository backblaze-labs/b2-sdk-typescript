import { describe, expect, it } from 'vitest'
import { deferred } from '../test-utils/index.ts'
import { racePromiseWithAbort } from './abort.ts'

describe('racePromiseWithAbort', () => {
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

    const raced = racePromiseWithAbort(request.promise, signal)
    request.reject(new Error('late request failure'))

    await expect(raced).rejects.toBe(reason)
  })
})
