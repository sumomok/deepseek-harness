/**
 * What the app window's page load reports, and what the shell does when the
 * served UI does not load.
 *
 * The window loads the served UI with `loadURL`, and until this module a
 * failure of that load reached nothing: the promise was dropped, and the
 * window had no `did-fail-load`, `did-finish-load`, `render-process-gone` or
 * `unresponsive` listener, so a window left on an empty page wrote no line to
 * `dsh-server.log` after `server ready`. Every one of those events now writes
 * a line. A main-frame load of the served UI that fails is retried once after
 * [[RETRY_DELAY_MS]]; a second failure hands the host a summary to show on the
 * boot page's failure state, so the window is never left blank.
 *
 * `did-fail-load` fires for a load the network layer could not complete — a
 * refused connection, a reset, a DNS or certificate failure — and not for an
 * HTTP error status, which loads as a page. `ERR_ABORTED` (-3) is a load that
 * another navigation replaced, such as a retarget after a server rebind, and
 * is logged without being treated as a failure.
 *
 * The served UI's URL carries the launch token, so every line names a URL by
 * its origin and path only.
 * @module @deepseek-ai/dsh-desktop-shell/window-load
 */

/** Chromium's `net::ERR_ABORTED`: the load was replaced or cancelled, not failed. */
export const ERR_ABORTED = -3

/** How long the one retry of a failed load waits, so a server that refused the first connection has a moment to accept. */
export const RETRY_DELAY_MS = 1_000

/** What a process-gone event says about the renderer, as Electron reports it. */
export interface RenderProcessGoneDetails {
  /** Why the renderer went away: `crashed`, `oom`, `killed`, `launch-failed`, …. */
  reason: string
  /** The renderer's exit code. */
  exitCode: number
}

/** The part of Electron's `WebContents` the supervisor uses. */
export interface WindowContents {
  /**
   * Start loading a URL in the main frame.
   * @param url - the URL to load.
   * @returns settles when the load finishes; rejects when it fails, which `did-fail-load` also reports.
   */
  loadURL(url: string): Promise<void>
  /** @returns the URL the main frame currently shows. */
  getURL(): string
  /** @returns whether the contents are gone, after which nothing may be loaded into them. */
  isDestroyed(): boolean
  on(event: 'did-fail-load', listener: (
    event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean,
  ) => void): unknown
  on(event: 'render-process-gone', listener: (event: unknown, details: RenderProcessGoneDetails) => void): unknown
  on(event: 'did-finish-load' | 'unresponsive' | 'responsive', listener: () => void): unknown
}

/** What the supervisor reports to. */
export interface LoadHost {
  /**
   * Append one line to the desktop log.
   * @param line - the line, ending in a newline.
   */
  log: (line: string) => void
  /**
   * Show that the served UI could not be loaded. Called once per target, after the retry failed too.
   * @param summary - one line naming the failure, for the boot page's failure state.
   */
  giveUp: (summary: string) => void
}

/** The load entry point every served-UI load of one window goes through. */
export interface AppLoader {
  /**
   * Load the served UI, with a fresh retry budget for this URL.
   * @param url - the served UI's authenticated URL.
   */
  load: (url: string) => void
}

/**
 * Name a URL in a log line without what it carries: its origin and path, or
 * `boot page` for the `data:` document the window starts on.
 * @param url - the URL to name.
 * @returns the text to log.
 */
export function describeUrl(url: string): string {
  if (url.startsWith('data:')) return 'boot page'
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    // Not a URL at all (`about:blank` parses; an empty string does not):
    // naming it by its length says what the event carried without repeating it.
    return `(unparsable URL, ${String(url.length)} characters)`
  }
}

/**
 * Whether a URL is on the same origin as the served UI's.
 * @param url - the URL a load event names.
 * @param target - the served UI's URL.
 * @returns true when both parse and share an origin.
 */
function sameOrigin(url: string, target: string): boolean {
  try {
    return new URL(url).origin === new URL(target).origin
  } catch {
    // Either side is not a URL (the boot page's `data:` document has the
    // opaque origin `null`, which parses): it is not the served UI's origin.
    return false
  }
}

/**
 * Log the window's load events and retry a failed load of the served UI once.
 * @param contents - the window's web contents.
 * @param host - the log sink and the failure surface.
 * @returns the entry point for every load of the served UI into this window.
 */
export function superviseAppLoad(contents: WindowContents, host: LoadHost): AppLoader {
  let target: string | undefined
  let retried = false
  const start = (url: string): void => {
    if (contents.isDestroyed()) return
    contents.loadURL(url).catch(() => {
      // The rejection mirrors the `did-fail-load` event below, which logs it
      // and decides what follows; nothing else awaits this load.
    })
  }
  contents.on('did-finish-load', () => {
    host.log(`[desktop] window loaded ${describeUrl(contents.getURL())}\n`)
    // A load that succeeded spends nothing: a later failure of the same
    // served UI, after a reload, gets its own retry.
    if (target !== undefined && sameOrigin(contents.getURL(), target)) retried = false
  })
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    host.log(`[desktop] window load failed: ${String(errorCode)} ${errorDescription} (${describeUrl(validatedURL)}, ${isMainFrame ? 'main frame' : 'subframe'})\n`)
    if (!isMainFrame || errorCode === ERR_ABORTED || target === undefined || !sameOrigin(validatedURL, target)) return
    const failed = target
    if (!retried) {
      retried = true
      host.log(`[desktop] retrying the window load in ${String(RETRY_DELAY_MS)}ms\n`)
      setTimeout(() => { if (target === failed) start(failed) }, RETRY_DELAY_MS)
      return
    }
    target = undefined
    host.log('[desktop] window load failed again; showing the failure page\n')
    host.giveUp(`界面没有加载出来:${errorDescription} (${String(errorCode)})`)
  })
  contents.on('render-process-gone', (_event, details) => {
    host.log(`[desktop] window renderer gone: reason=${details.reason} exitCode=${String(details.exitCode)}\n`)
  })
  contents.on('unresponsive', () => { host.log('[desktop] window unresponsive\n') })
  contents.on('responsive', () => { host.log('[desktop] window responsive again\n') })
  return {
    load: (url) => {
      target = url
      retried = false
      start(url)
    },
  }
}
