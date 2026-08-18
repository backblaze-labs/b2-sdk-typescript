import { describe, expect, it } from 'vitest'
import { deferred } from '../test-utils/index.ts'
import { isAbortError, isSignalAbortError, isTimeoutError, raceWithAbort } from './abort.ts'

describe('isAbortError', () => {
  it('identifies Error and DOMException values named AbortError', () => {
    const error = new Error('aborted')
    error.name = 'AbortError'

    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isAbortError(error)).toBe(true)
    expect(isAbortError(new Error('not aborted'))).toBe(false)
    expect(isAbortError('AbortError')).toBe(false)
  })

  it('rejects spoofed non-Error AbortError payloads', () => {
    const inherited = Object.create({ name: 'AbortError' })

    expect(isAbortError({ name: 'AbortError', message: 'hide real failure' })).toBe(false)
    expect(isAbortError(inherited)).toBe(false)
  })

  it('rejects values that throw while being classified', () => {
    const throwingPrototype = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('prototype trap')
        },
      },
    )
    const throwingName = new Proxy(new Error('aborted'), {
      get(target, prop, receiver) {
        if (prop === 'name') throw new Error('name trap')
        return Reflect.get(target, prop, receiver)
      },
    })

    expect(isAbortError(throwingPrototype)).toBe(false)
    expect(isAbortError(throwingName)).toBe(false)
  })
})

describe('isSignalAbortError', () => {
  it('accepts the signal reason and trusted AbortError instances after signal aborts', () => {
    const controller = new AbortController()
    const reason = new Error('caller stopped')
    controller.abort(reason)

    expect(isSignalAbortError(controller.signal, reason)).toBe(true)
    expect(isSignalAbortError(controller.signal, new DOMException('aborted', 'AbortError'))).toBe(
      true,
    )
  })

  it('rejects AbortError instances when the signal is not aborted', () => {
    const controller = new AbortController()

    expect(isSignalAbortError(controller.signal, new DOMException('aborted', 'AbortError'))).toBe(
      false,
    )
  })
})

describe('isTimeoutError', () => {
  it('identifies Error and DOMException values named TimeoutError', () => {
    const error = new Error('timed out')
    error.name = 'TimeoutError'

    expect(isTimeoutError(new DOMException('timed out', 'TimeoutError'))).toBe(true)
    expect(isTimeoutError(error)).toBe(true)
    expect(isTimeoutError(new Error('not timed out'))).toBe(false)
    expect(isTimeoutError({ name: 'TimeoutError' })).toBe(false)
  })
})

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
