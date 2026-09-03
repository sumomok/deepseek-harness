/**
 * Main-process crash logging. Electron's own `uncaughtException` handler
 * (`lib/browser/init.ts`) shows an error box and writes nothing, and it steps
 * aside as soon as the application registers a handler of its own
 * (`process.listenerCount('uncaughtException') > 1`). A shell that registers
 * none therefore loses every main-process exception: the user sees 「A
 * JavaScript error occurred in the main process」 and `dsh-server.log` — the
 * file the user is asked to send — has no record of it.
 *
 * What is registered here logs the exception and then opens that box itself.
 * For an `Error` the box is identical to Electron's, title and body. A thrown
 * value that is not an `Error` is rendered as `String(value)` instead, which
 * is not what Electron does: it reads `name` and `message` off the value and
 * composes `undefined: undefined`, or, for `undefined` and `null`, throws
 * while composing. Neither handler exits, because Electron's default does not
 * either — an exception raised on a background stream must not take a session
 * down with it.
 *
 * Rejections get the log entry alone: Electron shows no box for them, and one
 * appearing where there was none would read as a new failure. The launch chain
 * is the exception to that rule. Electron 43 runs main-process rejections in
 * `warn-with-error-code` mode, so a throw inside `whenReady` would otherwise
 * leave a boot with nothing on screen, nothing in the file, and a boot page
 * stopped where it was; `main.ts` catches that chain and reports it through
 * [[reportUncaughtException]] instead.
 * @module @deepseek-ai/dsh-desktop/crash-log
 */

/** What crash logging needs from the app. */
export interface CrashLogHost {
  /** Append one entry to the desktop log sink (the `dsh-server.log` stream). */
  log: (entry: string) => void
  /**
   * Show a modal error box. `dialog.showErrorBox` in the shell; the argument
   * order is that method's own (title, then content).
   */
  showErrorBox: (title: string, content: string) => void
}

/** The title of the box Electron's built-in handler opens. */
const ERROR_BOX_TITLE = 'A JavaScript error occurred in the main process'

/**
 * Render a thrown value or a rejection reason. An `Error` is rendered the way
 * Electron's own handler renders it — its stack, or the `name: message` line
 * when it carries none — so the box below is identical to the one Electron
 * would have shown. Anything else is rendered as `String(value)`, which
 * Electron cannot do: it reads `name` and `message` off the value.
 * @param value - the thrown value or rejection reason.
 * @returns the multi-line description to log and, for an exception, to show.
 */
function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  return String(value)
}

/**
 * Log one uncaught exception and show the box Electron would have shown for
 * it. Called by the registered handler, and by `main.ts` for the launch chain,
 * whose failures arrive as a rejection rather than as an exception.
 * @param host - the log sink and error box to report through.
 * @param value - whatever was thrown or rejected with, of any shape. Nothing
 * on this path may assume it is an `Error`: a handler that throws while
 * reporting is a process Node ends with no record at all.
 */
export function reportUncaughtException(host: CrashLogHost, value: unknown): void {
  const detail = describe(value)
  host.log(`[desktop] uncaught exception: ${detail}\n`)
  host.showErrorBox(ERROR_BOX_TITLE, `Uncaught Exception:\n${detail}`)
}

/**
 * Register the main process's `uncaughtException` and `unhandledRejection`
 * handlers. Call it once, as early in the launch as the log sink allows.
 * @param host - the log sink and error box to report through.
 * @returns a disposer that removes both handlers.
 */
export function setupCrashLog(host: CrashLogHost): () => void {
  const onUncaughtException = (value: unknown): void => { reportUncaughtException(host, value) }
  const onUnhandledRejection = (reason: unknown): void => {
    host.log(`[desktop] unhandled rejection: ${describe(reason)}\n`)
  }
  process.on('uncaughtException', onUncaughtException)
  process.on('unhandledRejection', onUnhandledRejection)
  return () => {
    process.off('uncaughtException', onUncaughtException)
    process.off('unhandledRejection', onUnhandledRejection)
  }
}
