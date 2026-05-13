import { describe, expect, it } from 'vitest'
import { bestEffort } from './best-effort.ts'

/**
 * Behavioural contract for {@link bestEffort}:
 *
 * - Success path: the inner promise's value is dropped (return type is
 *   always `Promise<void>`), but the function still runs.
 * - Failure path: an inner throw or rejection is swallowed, NOT
 *   re-thrown.
 *
 * The helper is used at cleanup boundaries where a secondary failure must
 * never shadow the primary error, so the contract is intentionally
 * permissive about WHY `fn` failed.
 */

describe('bestEffort', () => {
  it('runs the function on the success path and resolves to void', async () => {
    let called = false
    const result = await bestEffort(async () => {
      called = true
      return 'value-that-gets-discarded'
    })
    expect(called).toBe(true)
    expect(result).toBeUndefined()
  })

  it('swallows a thrown Error without re-throwing', async () => {
    let called = false
    await expect(
      bestEffort(async () => {
        called = true
        throw new Error('cleanup blew up')
      }),
    ).resolves.toBeUndefined()
    expect(called).toBe(true)
  })

  it('swallows a non-Error rejection without re-throwing', async () => {
    // Cleanup code in the wild can reject with strings, objects, etc.
    // `bestEffort` must swallow them all without inspection.
    await expect(
      bestEffort(async () => {
        throw 'plain-string-rejection'
      }),
    ).resolves.toBeUndefined()
  })

  it('swallows a synchronous throw from a non-async caller', async () => {
    // Defensive case: the caller might pass a function that's typed
    // async but throws synchronously before yielding.
    await expect(
      bestEffort(() => {
        throw new Error('sync throw')
      }),
    ).resolves.toBeUndefined()
  })
})
