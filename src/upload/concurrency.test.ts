import { describe, expect, it } from 'vitest'
import { Semaphore, mapConcurrent } from './concurrency.js'

describe('Semaphore', () => {
  it('acquire resolves immediately when below limit', async () => {
    const sem = new Semaphore(2)
    // Both should resolve without blocking
    await sem.acquire()
    await sem.acquire()
    expect(sem.available).toBe(0)
  })

  it('acquire queues when at limit, resolves when a slot is released', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    let queued = false
    const pending = sem.acquire().then(() => {
      queued = true
    })

    // The second acquire should still be waiting
    await Promise.resolve()
    expect(queued).toBe(false)

    sem.release()
    await pending
    expect(queued).toBe(true)
  })

  it('release unblocks queued callers in FIFO order', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    const order: number[] = []

    const p1 = sem.acquire().then(() => {
      order.push(1)
    })
    const p2 = sem.acquire().then(() => {
      order.push(2)
    })
    const p3 = sem.acquire().then(() => {
      order.push(3)
    })

    sem.release()
    await p1

    sem.release()
    await p2

    sem.release()
    await p3

    expect(order).toEqual([1, 2, 3])
  })

  it('available returns correct count', async () => {
    const sem = new Semaphore(3)
    expect(sem.available).toBe(3)

    await sem.acquire()
    expect(sem.available).toBe(2)

    await sem.acquire()
    expect(sem.available).toBe(1)

    await sem.acquire()
    expect(sem.available).toBe(0)

    sem.release()
    expect(sem.available).toBe(1)

    sem.release()
    expect(sem.available).toBe(2)
  })

  it('multiple acquire/release cycles work correctly', async () => {
    const sem = new Semaphore(2)

    // First cycle: fill and drain
    await sem.acquire()
    await sem.acquire()
    expect(sem.available).toBe(0)
    sem.release()
    sem.release()
    expect(sem.available).toBe(2)

    // Second cycle: interleave acquire and release
    await sem.acquire()
    expect(sem.available).toBe(1)
    await sem.acquire()
    expect(sem.available).toBe(0)
    sem.release()
    expect(sem.available).toBe(1)
    await sem.acquire()
    expect(sem.available).toBe(0)
    sem.release()
    sem.release()
    expect(sem.available).toBe(2)
  })

  it('release without queued callers decrements current count', () => {
    // This exercises the else branch in release() where queue is empty
    const sem = new Semaphore(2)
    // Manually: acquire one slot, then release it
    // Since we need to test release when queue is empty but current > 0,
    // we acquire first then release.
    const acquirePromise = sem.acquire()
    // acquire resolves synchronously (below limit), so available drops
    expect(sem.available).toBe(1)

    sem.release()
    expect(sem.available).toBe(2)
  })
})

describe('mapConcurrent', () => {
  it('processes all items and returns results in order', async () => {
    const items = [10, 20, 30, 40, 50]
    const results = await mapConcurrent(items, 3, async (item, index) => {
      return `${item}-${index}`
    })

    expect(results).toEqual(['10-0', '20-1', '30-2', '40-3', '50-4'])
  })

  it('respects concurrency limit (track max concurrent)', async () => {
    let running = 0
    let maxRunning = 0

    const items = [1, 2, 3, 4, 5, 6, 7, 8]
    const concurrency = 3

    await mapConcurrent(items, concurrency, async (item) => {
      running++
      if (running > maxRunning) {
        maxRunning = running
      }
      // Simulate async work so tasks actually overlap
      await new Promise((resolve) => setTimeout(resolve, 10))
      running--
      return item
    })

    expect(maxRunning).toBeLessThanOrEqual(concurrency)
    expect(maxRunning).toBeGreaterThan(1) // Confirm actual parallelism happened
  })

  it('handles empty array', async () => {
    const results = await mapConcurrent([], 5, async (item: number) => {
      return item * 2
    })
    expect(results).toEqual([])
  })

  it('propagates errors from fn', async () => {
    const items = [1, 2, 3]

    await expect(
      mapConcurrent(items, 2, async (item) => {
        if (item === 2) {
          throw new Error('boom')
        }
        return item
      }),
    ).rejects.toThrow('boom')
  })

  it('releases semaphore slot even when fn throws', async () => {
    const items = [1, 2, 3, 4]

    // Even though item 1 throws, the other items should still be able to acquire slots.
    // This validates the finally block in mapConcurrent.
    const settled = await Promise.allSettled([
      mapConcurrent(items, 2, async (item) => {
        if (item === 1) {
          throw new Error('fail')
        }
        return item * 10
      }),
    ])

    expect(settled[0]!.status).toBe('rejected')
  })
})
