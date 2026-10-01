/**
 * Hearing that the operating system is ending the user's session — a
 * shutdown, a restart, or a log-off — so the crash-resume sentinel can be
 * written before the system ends the server.
 *
 * Electron reports it differently per platform. On Windows it is each
 * window's `session-end` event, and `before-quit` is not emitted for such an
 * end, so without this the server dies with no sentinel and the next start
 * reads the shutdown as a crash. On macOS and Linux it is `powerMonitor`'s
 * `shutdown` event. The listener runs at most once per process, whichever
 * source reports first.
 * @module @deepseek-ai/dsh-desktop-shell/session-end
 */

/** An emitter of one event with no arguments the listener needs. */
interface EventSource<E extends string> {
  /** Register `listener` for `event`. */
  on: (event: E, listener: () => void) => unknown
}

/** Where the session end is reported. */
export interface SessionEndSources {
  /** `process.platform`. */
  platform: NodeJS.Platform
  /** Electron's `powerMonitor`, whose `shutdown` event fires on macOS and Linux. */
  powerMonitor: EventSource<'shutdown'>
  /**
   * Call `listener` with every window created from now on, and with each one
   * that already exists; on Windows each window reports `session-end`.
   */
  eachWindow: (listener: (window: EventSource<'session-end'>) => void) => void
}

/**
 * Call `onEnd` once when the system ends the user's session.
 * @param sources - the platform and Electron's event sources.
 * @param onEnd - runs synchronously in the event, before the system goes on.
 */
export function watchSessionEnd(sources: SessionEndSources, onEnd: () => void): void {
  let ended = false
  const once = (): void => {
    if (ended) return
    ended = true
    onEnd()
  }
  if (sources.platform === 'win32') {
    sources.eachWindow((window) => { window.on('session-end', once) })
    return
  }
  sources.powerMonitor.on('shutdown', once)
}
