/**
 * Run an asynchronous task over a list with a bounded number of calls in
 * flight, reporting results and failures in list order rather than in the
 * order the calls finish.
 * @module
 */

/**
 * Call `task` once per item, starting items in list order with at most
 * `concurrency` calls unsettled at a time.
 *
 * Results and failures do not depend on the order the calls finish in. Each
 * result lands at its item's index. Once a call rejects, no further item is
 * started; the returned promise waits for every started call to settle and
 * then rejects with the error of the lowest-index item that rejected. Because
 * items start in list order, every item before the first rejected one has
 * started by then, so that error is the one a one-at-a-time loop over the same
 * items would have stopped on.
 * @param items - the items, in the order results are returned and started.
 * @param concurrency - the most calls unsettled at once, at least 1.
 * @param task - the call for one item; `index` is the item's position in `items`.
 * @returns every item's result, at the item's index.
 */
export async function mapInOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  const failures = new Map<number, unknown>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (failures.size === 0 && next < items.length) {
      const index = next++
      try {
        results[index] = await task(items[index] as T, index)
      } catch (error) {
        failures.set(index, error)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  if (failures.size > 0) throw failures.get(Math.min(...failures.keys()))
  return results
}
