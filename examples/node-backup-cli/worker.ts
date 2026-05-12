/**
 * Bounded-concurrency worker pool.
 *
 * Most backup tools either (a) serialize, which is glacial, or (b) launch a
 * Promise.all over every file, which spawns thousands of concurrent uploads
 * and either OOMs the process or saturates the B2 connection-per-account
 * limit. A simple capped pool of N workers pulling from a queue handles both.
 */

/**
 * Run `tasks` with at most `concurrency` running at once. Preserves submission
 * order in the returned results array.
 *
 * @param tasks - The tasks to execute. Each is a thunk returning a Promise.
 * @param concurrency - Maximum number of tasks running at any moment.
 *
 * @returns The resolved results in the same order as the input tasks.
 *
 * @throws If any task rejects. Remaining queued tasks are abandoned; in-flight
 * tasks are awaited so we don't leak unhandled-rejection warnings.
 */
export async function pool<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  if (concurrency < 1) throw new Error('concurrency must be >= 1')
  const results: T[] = new Array(tasks.length)
  let cursor = 0
  let firstError: unknown

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= tasks.length) return
      if (firstError !== undefined) return
      const task = tasks[i]
      if (!task) return
      try {
        results[i] = await task()
      } catch (err) {
        if (firstError === undefined) firstError = err
        return
      }
    }
  })

  await Promise.all(workers)
  if (firstError !== undefined) throw firstError
  return results
}
