/**
 * One task at a time: a second start while the first still runs is refused
 * rather than queued. The data move's cleanup uses it, so the launch's own
 * background cleanup and a retry asked for from Settings never delete the old
 * copy side by side.
 * @module @deepseek-ai/dsh-desktop-shell/single-flight
 */

/** A slot that runs one task at a time. */
export interface SingleFlight {
  /**
   * Start `task` unless one is running.
   * @param task - the work; its rejection is passed to `onError` and frees the slot like a resolution.
   * @returns true when it started, false when another task still runs.
   */
  run: (task: () => Promise<void>) => boolean
  /**
   * Whether a task is running.
   * @returns true between a started task's start and its settling.
   */
  running: () => boolean
}

/**
 * Create a slot.
 * @param onError - receives what a task rejected with.
 * @returns the slot.
 */
export function singleFlight(onError: (error: unknown) => void): SingleFlight {
  let busy = false
  return {
    run: (task) => {
      if (busy) return false
      busy = true
      void Promise.resolve().then(task).catch(onError).finally(() => { busy = false })
      return true
    },
    running: () => busy,
  }
}
