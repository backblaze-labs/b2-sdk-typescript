/**
 * Bounded concurrency primitive.
 *
 * Limits the number of concurrent operations to a fixed maximum. Callers
 * {@link acquire} a slot before starting work and {@link release} it when done.
 * If all slots are taken, `acquire` returns a promise that resolves when a slot
 * becomes available.
 */
export class Semaphore {
  private current = 0
  private readonly queue: (() => void)[] = []

  /** @param limit - Maximum number of concurrent acquisitions. */
  constructor(private readonly limit: number) {}

  /**
   * Acquires a slot, waiting if the limit has been reached.
   * @returns A promise that resolves when a slot is available.
   */
  async acquire(): Promise<void> {
    if (this.current < this.limit) {
      this.current++
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  /** Releases a slot, unblocking the next queued caller if any. */
  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.current--
    }
  }

  /**
   * Number of slots currently available.
   *
   * @returns The count of free concurrency slots.
   */
  get available(): number {
    return this.limit - this.current
  }
}

/**
 * Maps over an array with bounded concurrency.
 *
 * @param items - Input items to process.
 * @param concurrency - Maximum number of items processed in parallel.
 * @param fn - Async function applied to each item.
 *
 * @returns Results in the same order as the input items.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const sem = new Semaphore(concurrency)
  const results: R[] = new Array(items.length)
  const tasks = items.map(async (item, i) => {
    await sem.acquire()
    try {
      results[i] = await fn(item, i)
    } finally {
      sem.release()
    }
  })
  await Promise.all(tasks)
  return results
}
