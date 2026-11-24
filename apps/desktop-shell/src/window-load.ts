/**
 * What the app window's page load reports, and what the shell does when the
 * served UI fails to load or its renderer process disappears.
 *
 * Every load event writes a line to `dsh-server.log`: `did-finish-load`,
 * `did-fail-load`, `render-process-gone`, `unresponsive`, `responsive`,
 * `preload-error`, and rate-limited `error`-level `console-message` records.
 * A main-frame load of the served UI that fails is retried once after
 * [[RETRY_DELAY_MS]]; a second failure hands the host a summary to show on the
 * boot page's failure state, so the window is never left blank. Only
 * [[AppLoader.load]] restores the retry: a load that finished does not, since
 * a failed load also ends in `did-finish-load`, for the error page Chromium
 * commits under the same URL.
 *
 * When a renderer displaying the served UI disappears unexpectedly
 * (`render-process-gone` with a reason other than `clean-exit`, while the app
 * is not quitting), the supervisor reloads it after [[RETRY_DELAY_MS]] up to
 * [[RENDERER_AUTO_RELOAD_MAX]] time per [[RENDERER_CRASH_WINDOW_MS]] sliding
 * window, preserving the current subpath or fragment via [[selectRecoveryUrl]].
 * A repeated crash within the window stops auto-reloading and asks the host to
 * show the failure page with [[RENDERER_GONE_SUMMARY]].
 *
 * A `did-finish-load` that follows a main-frame failure, with no navigation
 * started in between, is the error page Chromium commits for the failed URL;
 * it is logged as `window showed the error page`, so `window loaded` means a
 * page that loaded.
 *
 * `did-fail-load` fires for a load the network layer could not complete — a
 * refused connection, a reset, a DNS or certificate failure — and not for an
 * HTTP error status, which loads as a page. `ERR_ABORTED` (-3) is a load that
 * another navigation replaced, such as a retarget after a server rebind, and
 * is logged without being treated as a failure.
 *
 * The served UI's URL carries the launch token, so every line names a URL by
 * its origin and path only and redacts tokens from preload and console errors.
 * @module @deepseek-ai/dsh-desktop-shell/window-load
 */

import { basename } from 'node:path'

/** Chromium's `net::ERR_ABORTED`: the load was replaced or cancelled, not failed. */
export const ERR_ABORTED = -3

/** How long a retry after a failed load or unexpected renderer exit waits before reloading. */
export const RETRY_DELAY_MS = 1_000

/** Sliding window in which repeated renderer crashes trip the auto-reload circuit breaker. */
export const RENDERER_CRASH_WINDOW_MS = 60_000

/** Maximum automatic reloads allowed after unexpected renderer exits within [[RENDERER_CRASH_WINDOW_MS]]. */
export const RENDERER_AUTO_RELOAD_MAX = 1

/** User-facing failure summary shown when the renderer crashes repeatedly within [[RENDERER_CRASH_WINDOW_MS]]. */
export const RENDERER_GONE_SUMMARY = '界面多次意外退出，后台任务未受影响；可点击下方按钮或按 Ctrl+R / Cmd+R 重新加载。'

/** Maximum characters retained per sanitized renderer console or preload error message in `dsh-server.log`. */
export const CONSOLE_ERROR_MAX_CHARS = 500

/** Fixed rate-limit window for logging renderer `console-message` error entries. */
export const CONSOLE_ERROR_WINDOW_MS = 60_000

/** Maximum renderer `console-message` error entries logged per [[CONSOLE_ERROR_WINDOW_MS]] window. */
export const CONSOLE_ERROR_MAX_PER_WINDOW = 20

/** Query-parameter token pattern redacted from logged renderer error messages. */
const TOKEN_QUERY_PATTERN = /([?&]token=)[^&#\s"'<>)]+/giu

/** What a process-gone event says about the renderer, as Electron reports it. */
export interface RenderProcessGoneDetails {
  /** Why the renderer went away: `crashed`, `oom`, `killed`, `launch-failed`, …. */
  reason: string
  /** The renderer's exit code. */
  exitCode: number
}

/** What `did-start-navigation` says about the navigation, as Electron reports it on its event object. */
export interface NavigationStart {
  /** Whether the main frame is navigating. */
  isMainFrame: boolean
  /** Whether the navigation stays in the current document (a fragment or History API change). */
  isSameDocument: boolean
}

/** What `console-message` reports on its event object in Electron 35+. */
export interface ConsoleMessageDetails {
  /** Message severity (`'debug'`, `'info'`, `'warning'`, or `'error'`). */
  level: string
  /** Console message text. */
  message: string
  /** One-based source line number, or 0 when unavailable. */
  lineNumber: number
  /** Source URL or script identifier. */
  sourceId: string
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
  on(event: 'did-start-navigation', listener: (details: NavigationStart) => void): unknown
  on(event: 'did-finish-load' | 'unresponsive' | 'responsive', listener: () => void): unknown
  on(event: 'preload-error', listener: (event: unknown, preloadPath: string, error: Error) => void): unknown
  on(event: 'console-message', listener: (details: ConsoleMessageDetails) => void): unknown
}

/** What the supervisor reports to. */
export interface LoadHost {
  /**
   * Append one line to the desktop log.
   * @param line - the line, ending in a newline.
   */
  log: (line: string) => void
  /**
   * Show that the served UI could not be loaded or recovered. Called once per target, after retries or auto-reloads are exhausted.
   * @param summary - one line naming the failure, for the boot page's failure state.
   */
  giveUp: (summary: string) => void
  /**
   * Whether the app is quitting or the OS session is ending, during which
   * renderer teardown must not schedule reloads or show a failure page.
   * @returns true when shutdown is under way.
   */
  isQuitting: () => boolean
}

/** The load entry point every served-UI load of one window goes through. */
export interface AppLoader {
  /**
   * Load the served UI, with a fresh retry and renderer-crash recovery budget for this URL.
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
 * Choose the URL to load when automatically recovering after a renderer crash.
 *
 * A window on another origin (such as the boot page or `about:blank`) falls
 * back to `target`. A window at the served origin's root path without a query
 * string reloads `target` — re-minting the auth cookie through `?token=` — and
 * preserves any fragment (`#hash`). Any deeper subpath or query on the served
 * origin is kept as-is, relying on the still-valid `dsh-auth-*` cookie.
 * @param currentUrl - the URL the crashed window was showing.
 * @param target - the served UI's authenticated launch URL.
 * @returns the URL to pass to `loadURL`.
 */
export function selectRecoveryUrl(currentUrl: string, target: string): string {
  if (!sameOrigin(currentUrl, target)) return target
  const current = new URL(currentUrl)
  if (current.pathname === '/' && current.search === '') {
    return current.hash === '' ? target : `${target}${current.hash}`
  }
  return currentUrl
}

/**
 * Extract the non-empty `token` query parameter from a served-UI URL so later
 * log sanitization can redact literal copies of the active launch token.
 * @param url - the URL passed to [[AppLoader.load]].
 * @returns the launch token, or undefined when absent or unparsable.
 */
function extractLaunchToken(url: string): string | undefined {
  try {
    const token = new URL(url).searchParams.get('token')
    return token !== null && token.length > 0 ? token : undefined
  } catch {
    // Non-URL load targets carry no launch token.
    return undefined
  }
}

/**
 * Format a `console-message` source identifier for `dsh-server.log` without
 * query parameters, fragments, or raw unparsable strings.
 * @param sourceId - the script URL or source identifier reported by Electron.
 * @param lineNumber - one-based line number, or 0 when absent.
 * @returns the sanitized source label, with `:lineNumber` when positive.
 */
function describeConsoleSource(sourceId: string, lineNumber: number): string {
  let base: string
  if (sourceId.startsWith('data:')) {
    base = 'boot page'
  } else {
    try {
      const parsed = new URL(sourceId)
      if (parsed.origin !== 'null' && parsed.protocol !== 'blob:') {
        base = `${parsed.origin}${parsed.pathname}`
      } else {
        parsed.search = ''
        parsed.hash = ''
        base = parsed.href
      }
    } catch {
      // Unparsable or empty source identifiers are described by length only.
      base = `(unparsable source, ${String(sourceId.length)} characters)`
    }
  }
  return lineNumber > 0 ? `${base}:${String(lineNumber)}` : base
}

/**
 * Sanitize a renderer error message for single-line logging: redact launch
 * tokens, collapse line breaks to spaces, and cap length at [[CONSOLE_ERROR_MAX_CHARS]].
 * @param message - the raw error message text.
 * @param activeLaunchToken - the active served-UI launch token, if any.
 * @returns the sanitized single-line text.
 */
function sanitizeLogMessage(message: string, activeLaunchToken: string | undefined): string {
  let sanitized = message.replace(TOKEN_QUERY_PATTERN, '$1[redacted]')
  if (activeLaunchToken !== undefined && activeLaunchToken.length > 0) {
    sanitized = sanitized.replaceAll(activeLaunchToken, '[redacted]')
  }
  sanitized = sanitized.replace(/[\r\n]+/gu, ' ')
  return sanitized.length <= CONSOLE_ERROR_MAX_CHARS
    ? sanitized
    : `${sanitized.slice(0, CONSOLE_ERROR_MAX_CHARS - 1)}…`
}

/**
 * Log the window's load and renderer events, retry a failed load of the served
 * UI once, and auto-reload an unexpectedly gone renderer behind a circuit breaker.
 * @param contents - the window's web contents.
 * @param host - the log sink, failure surface, and shutdown check.
 * @returns the entry point for every load of the served UI into this window.
 */
export function superviseAppLoad(contents: WindowContents, host: LoadHost): AppLoader {
  let target: string | undefined
  let retried = false
  // Whether the main frame's current navigation failed. Chromium then commits
  // its error page and reports `did-finish-load` for it, which must not read
  // as the page having loaded. Every load, `load` and the retry included,
  // starts a main-frame navigation, which clears it.
  let failedSinceStart = false
  let pendingTimer: ReturnType<typeof setTimeout> | undefined
  let recentRendererCrashes: number[] = []
  let activeLaunchToken: string | undefined
  let consoleWindowStart = 0
  let consoleCount = 0
  let consoleSuppressed = 0
  const cancelPending = (): void => {
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer)
      pendingTimer = undefined
    }
  }
  const start = (url: string): void => {
    if (contents.isDestroyed()) return
    contents.loadURL(url).catch(() => {
      // The rejection mirrors the `did-fail-load` event below, which logs it
      // and decides what follows; nothing else awaits this load.
    })
  }
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) failedSinceStart = false
  })
  contents.on('did-finish-load', () => {
    // Logged only. A finished load does not restore the retry: after a failed
    // load Chromium commits its error page and reports `did-finish-load` for
    // the same URL, so restoring here would retry a dead server forever.
    const shown = describeUrl(contents.getURL())
    host.log(failedSinceStart ? `[desktop] window showed the error page for ${shown}\n` : `[desktop] window loaded ${shown}\n`)
  })
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    host.log(`[desktop] window load failed: ${String(errorCode)} ${errorDescription} (${describeUrl(validatedURL)}, ${isMainFrame ? 'main frame' : 'subframe'})\n`)
    if (isMainFrame && errorCode !== ERR_ABORTED) failedSinceStart = true
    if (!isMainFrame || errorCode === ERR_ABORTED || target === undefined || !sameOrigin(validatedURL, target)) return
    const failed = target
    if (!retried) {
      retried = true
      cancelPending()
      host.log(`[desktop] retrying the window load in ${String(RETRY_DELAY_MS)}ms\n`)
      pendingTimer = setTimeout(() => {
        pendingTimer = undefined
        if (target === failed && !contents.isDestroyed() && !host.isQuitting()) start(failed)
      }, RETRY_DELAY_MS)
      return
    }
    cancelPending()
    target = undefined
    host.log('[desktop] window load failed again; showing the failure page\n')
    host.giveUp(`界面没有加载出来:${errorDescription} (${String(errorCode)})`)
  })
  contents.on('render-process-gone', (_event, details) => {
    host.log(`[desktop] window renderer gone: reason=${details.reason} exitCode=${String(details.exitCode)}\n`)
    if (details.reason === 'clean-exit' || contents.isDestroyed() || host.isQuitting() || target === undefined) return
    const now = Date.now()
    recentRendererCrashes = recentRendererCrashes.filter(at => now - at < RENDERER_CRASH_WINDOW_MS)
    if (recentRendererCrashes.length >= RENDERER_AUTO_RELOAD_MAX) {
      cancelPending()
      target = undefined
      host.log('[desktop] window renderer crashed repeatedly; showing the failure page\n')
      host.giveUp(RENDERER_GONE_SUMMARY)
      return
    }
    recentRendererCrashes.push(now)
    retried = false
    const failedTarget = target
    const recoveryUrl = selectRecoveryUrl(contents.getURL(), failedTarget)
    cancelPending()
    host.log(`[desktop] reloading the window in ${String(RETRY_DELAY_MS)}ms after renderer gone\n`)
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined
      if (target === failedTarget && !contents.isDestroyed() && !host.isQuitting()) start(recoveryUrl)
    }, RETRY_DELAY_MS)
  })
  contents.on('preload-error', (_event, preloadPath, error) => {
    host.log(`[desktop] window preload error: ${basename(preloadPath)}: ${sanitizeLogMessage(error.message, activeLaunchToken)}\n`)
  })
  contents.on('console-message', (details) => {
    if (details.level !== 'error') return
    const now = Date.now()
    if (consoleCount === 0 || now - consoleWindowStart >= CONSOLE_ERROR_WINDOW_MS) {
      if (consoleSuppressed > 0) {
        host.log(`[desktop] suppressed ${String(consoleSuppressed)} window console error(s) in the previous rate-limit window\n`)
        consoleSuppressed = 0
      }
      consoleWindowStart = now
      consoleCount = 0
    }
    consoleCount += 1
    if (consoleCount > CONSOLE_ERROR_MAX_PER_WINDOW) {
      consoleSuppressed += 1
      if (consoleSuppressed === 1) {
        host.log(`[desktop] window console error rate limit reached (${String(CONSOLE_ERROR_MAX_PER_WINDOW)} per ${String(CONSOLE_ERROR_WINDOW_MS / 1000)}s); suppressing further errors until the next window\n`)
      }
      return
    }
    const source = describeConsoleSource(details.sourceId, details.lineNumber)
    host.log(`[desktop] window console error (${source}): ${sanitizeLogMessage(details.message, activeLaunchToken)}\n`)
  })
  contents.on('unresponsive', () => { host.log('[desktop] window unresponsive\n') })
  contents.on('responsive', () => { host.log('[desktop] window responsive again\n') })
  return {
    load: (url) => {
      cancelPending()
      target = url
      retried = false
      recentRendererCrashes = []
      activeLaunchToken = extractLaunchToken(url)
      start(url)
    },
  }
}
