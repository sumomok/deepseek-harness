/**
 * One task at a time: a second start while the first still runs is refused
 * rather than queued. The data move's cleanup uses it, so the launch's own
 * background cleanup and a retry asked for from Settings never delete the old
 * copy side by side, and the launch waits on it before an Office engine
 * upgrade's download.
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
  /**
   * Wait until no task runs.
   * @returns resolves at once when the slot is free, otherwise once the running task settled, however it settled;
   * rejects only when `onError` threw for that task.
   */
  idle: () => Promise<void>
}

/**
 * Create a slot.
 * @param onError - receives what a task rejected with.
 * @returns the slot.
 */
export function singleFlight(onError: (error: unknown) => void): SingleFlight {
  let current: Promise<void> | undefined
  return {
    run: (task) => {
      if (current !== undefined) return false
      current = Promise.resolve().then(task).catch(onError).finally(() => { current = undefined })
      return true
    },
    running: () => current !== undefined,
    idle: () => current ?? Promise.resolve(),
  }
}
