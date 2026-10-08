/**
 * A set of listeners that are called in registration order and isolated
 * from each other: a listener that throws is logged with a fixed line, never
 * with its error or the arguments it was called with, and the others still
 * run.
 * @module @deepseek-ai/dsh-experimental-console-members/src/listeners
 */

import type { Logger } from '@deepseek-ai/cordis'

/** Listeners of one notification, called with the arguments `A`. */
export class Listeners<A extends readonly unknown[]> {
  private readonly listeners = new Set<(...args: A) => void>()

  /**
   * @param logger - the row's logger.
   * @param failure - the whole line logged when a listener throws; it names the notification and carries no argument.
   */
  constructor(private readonly logger: Logger, private readonly failure: string) {}

  /**
   * Add a listener. Adding one function twice registers it twice.
   * @param listener - the listener.
   * @returns the disposer that removes this registration; an {@link emit} already running still calls it.
   */
  add(listener: (...args: A) => void): () => void {
    const registered = (...args: A): void => { listener(...args) }
    this.listeners.add(registered)
    return () => { this.listeners.delete(registered) }
  }

  /**
   * Call every listener registered when the call starts, including one
   * removed while the call runs; a listener added while it runs is not
   * called.
   * @param args - the arguments each listener is called with.
   */
  emit(...args: A): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(...args)
      } catch (_listenerFailure) {
        // The listener's error can quote a principal key, so neither the error nor the arguments are logged.
        this.logger.warn(this.failure)
      }
    }
  }
}
