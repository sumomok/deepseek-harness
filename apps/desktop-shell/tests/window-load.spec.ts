/**
 * The app window's load supervision against a stand-in for Electron's
 * `WebContents`: which events write which lines, when a failed load of the
 * served UI is retried, and when the failure page is asked for instead.
 * @module
 */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONSOLE_ERROR_MAX_CHARS,
  CONSOLE_ERROR_MAX_PER_WINDOW,
  CONSOLE_ERROR_WINDOW_MS,
  describeUrl,
  ERR_ABORTED,
  RENDERER_AUTO_RELOAD_MAX,
  RENDERER_CRASH_WINDOW_MS,
  RENDERER_GONE_SUMMARY,
  RETRY_DELAY_MS,
  selectRecoveryUrl,
  superviseAppLoad,
} from '../src/window-load.ts'

/** The launch token every served-UI URL here carries, which no log line may repeat. */
const TOKEN = 'launch-token-4f1c9e'

/** The served UI's authenticated URL. */
const APP_URL = `http://127.0.0.1:54321/?token=${TOKEN}`

/** Chromium's `net::ERR_CONNECTION_REFUSED`. */
const REFUSED = -102

/** A `WebContents` stand-in whose events a case raises by hand. */
class FakeContents extends EventEmitter {
  /** Every URL `loadURL` was asked for, in order. */
  loads: string[] = []
  /** What `getURL` answers. */
  current = 'data:text/html,boot'
  /** What `isDestroyed` answers. */
  destroyed = false

  loadURL(url: string): Promise<void> {
    this.loads.push(url)
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    return Promise.reject(new Error('ERR_CONNECTION_REFUSED (-102) loading ' + url))
  }

  getURL(): string {
    return this.current
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  /**
   * Raise `did-fail-load` the way Electron does.
   * @param code - the net error code.
   * @param url - the URL the load was for.
   * @param isMainFrame - whether the main frame failed.
   */
  failLoad(code: number, url: string, isMainFrame = true): void {
    this.emit('did-fail-load', {}, code, code === ERR_ABORTED ? 'ERR_ABORTED' : 'ERR_CONNECTION_REFUSED', url, isMainFrame)
  }

  /**
   * Raise `did-finish-load` for a page now showing `url`.
   * @param url - the page's URL.
   */
  finishLoad(url: string): void {
    this.current = url
    this.emit('did-finish-load')
  }

  /**
   * Raise `render-process-gone` the way Electron does.
   * @param reason - Electron's gone reason (`crashed`, `oom`, `clean-exit`, …).
   * @param exitCode - the renderer process exit code.
   */
  rendererGone(reason: string, exitCode = 1): void {
    this.emit('render-process-gone', {}, { reason, exitCode })
  }

  /**
   * Raise `console-message` using Electron 35+'s single details object shape.
   * @param details - the event details payload.
   */
  consoleMessage(details: { level: string; message: string; lineNumber: number; sourceId: string }): void {
    this.emit('console-message', details)
  }
}

let contents: FakeContents
let lines: string[]
let failures: string[]
let quitting: boolean

/** Supervise [[contents]], recording into [[lines]] and [[failures]]. */
function supervise(): ReturnType<typeof superviseAppLoad> {
  return superviseAppLoad(contents, {
    log: (line) => { lines.push(line) },
    giveUp: (summary) => { failures.push(summary) },
    isQuitting: () => quitting,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  contents = new FakeContents()
  lines = []
  failures = []
  quitting = false
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a failed load of the served UI', () => {
  it('is retried once, with the same URL, after the retry delay', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(REFUSED, APP_URL)

    expect(contents.loads).toEqual([APP_URL])
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    expect(contents.loads).toEqual([APP_URL, APP_URL])
    expect(failures).toEqual([])
  })

  it('asks for the failure page once the retry fails too, naming the error and its code', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(REFUSED, APP_URL)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    contents.failLoad(REFUSED, APP_URL)

    expect(failures).toEqual(['界面没有加载出来:ERR_CONNECTION_REFUSED (-102)'])
    // Nothing is tried after giving up, whatever else fails.
    contents.failLoad(REFUSED, APP_URL)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 5)
    expect(contents.loads).toHaveLength(2)
    expect(failures).toHaveLength(1)
  })

  it('gets a fresh retry for every URL `load` is given, which is how a rebind retargets the window', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(REFUSED, APP_URL)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    contents.failLoad(REFUSED, APP_URL)
    const rebound = `http://127.0.0.1:60000/?token=${TOKEN}`
    loader.load(rebound)
    contents.failLoad(REFUSED, rebound)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

    expect(contents.loads).toEqual([APP_URL, APP_URL, rebound, rebound])
    expect(failures).toHaveLength(1)
  })

  it('gives up after the retry even though Chromium reports each failed load finished, on its error page', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(REFUSED, APP_URL)
    contents.finishLoad(APP_URL)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    contents.failLoad(REFUSED, APP_URL)
    contents.finishLoad(APP_URL)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 5)

    expect(contents.loads).toEqual([APP_URL, APP_URL])
    expect(failures).toEqual(['界面没有加载出来:ERR_CONNECTION_REFUSED (-102)'])
  })

  it('does not reload the URL a failed load was for once a retarget replaced it during the wait', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(REFUSED, APP_URL)
    const rebound = `http://127.0.0.1:60000/?token=${TOKEN}`
    loader.load(rebound)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

    expect(contents.loads).toEqual([APP_URL, rebound])
  })

  it('does not retry into a window that was closed meanwhile', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(REFUSED, APP_URL)
    contents.destroyed = true
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    expect(contents.loads).toEqual([APP_URL])
  })
})

describe('a failure that is not the served UI failing', () => {
  it('ignores an aborted load, which is a navigation replacing it', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(ERR_ABORTED, APP_URL)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

    expect(contents.loads).toEqual([APP_URL])
    expect(failures).toEqual([])
    expect(lines.some(line => line.includes('window load failed: -3 ERR_ABORTED'))).toBe(true)
  })

  it('ignores a subframe, another origin, and a failure before any served-UI load', async () => {
    supervise()
    contents.failLoad(REFUSED, APP_URL)
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(REFUSED, APP_URL, false)
    contents.failLoad(REFUSED, 'https://example.com/')
    contents.failLoad(REFUSED, 'data:text/html,boot')
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

    expect(contents.loads).toEqual([APP_URL])
    expect(failures).toEqual([])
  })
})

describe('the log lines', () => {
  it('names the error page Chromium commits after a failed load, not a loaded page', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(REFUSED, APP_URL)
    contents.finishLoad(APP_URL)
    // A subframe or same-document navigation does not start a new page load.
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    contents.finishLoad(APP_URL)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    contents.finishLoad(APP_URL)

    expect(lines.filter(line => line.includes('window loaded') || line.includes('error page'))).toEqual([
      '[desktop] window showed the error page for http://127.0.0.1:54321/\n',
      '[desktop] window showed the error page for http://127.0.0.1:54321/\n',
      '[desktop] window loaded http://127.0.0.1:54321/\n',
    ])
  })

  it('counts an aborted load as no failure of the page that replaced it', () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(ERR_ABORTED, APP_URL)
    contents.finishLoad(APP_URL)
    expect(lines.at(-1)).toBe('[desktop] window loaded http://127.0.0.1:54321/\n')
  })

  it('names every event, and the served UI by origin and path only', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(REFUSED, APP_URL)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    contents.finishLoad(APP_URL)
    contents.emit('unresponsive')
    contents.emit('responsive')
    contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -536870904 })

    expect(lines).toEqual([
      '[desktop] window load failed: -102 ERR_CONNECTION_REFUSED (http://127.0.0.1:54321/, main frame)\n',
      `[desktop] retrying the window load in ${String(RETRY_DELAY_MS)}ms\n`,
      '[desktop] window loaded http://127.0.0.1:54321/\n',
      '[desktop] window unresponsive\n',
      '[desktop] window responsive again\n',
      '[desktop] window renderer gone: reason=oom exitCode=-536870904\n',
      `[desktop] reloading the window in ${String(RETRY_DELAY_MS)}ms after renderer gone\n`,
    ])
    expect(lines.join('')).not.toContain(TOKEN)
  })

  it('names the boot page and a string that is not a URL without repeating them', () => {
    expect(describeUrl('data:text/html;charset=utf-8,%3C!doctype%20html%3E')).toBe('boot page')
    expect(describeUrl(`http://127.0.0.1:1/api?token=${TOKEN}#x`)).toBe('http://127.0.0.1:1/api')
    expect(describeUrl('not a url')).toBe('(unparsable URL, 9 characters)')
  })
})

describe('selectRecoveryUrl', () => {
  it('falls back to target when the current URL is on another origin or unparsable', () => {
    expect(selectRecoveryUrl('data:text/html,boot', APP_URL)).toBe(APP_URL)
    expect(selectRecoveryUrl('about:blank', APP_URL)).toBe(APP_URL)
    expect(selectRecoveryUrl('https://example.com/chat', APP_URL)).toBe(APP_URL)
    expect(selectRecoveryUrl('', APP_URL)).toBe(APP_URL)
  })

  it('re-authenticates `/` without query and preserves any `#hash`', () => {
    expect(selectRecoveryUrl('http://127.0.0.1:54321/', APP_URL)).toBe(APP_URL)
    expect(selectRecoveryUrl('http://127.0.0.1:54321/#session-9', APP_URL)).toBe(`${APP_URL}#session-9`)
  })

  it('preserves deeper subpaths and query URLs on the served origin', () => {
    const deep = 'http://127.0.0.1:54321/settings/models?pane=keys#top'
    expect(selectRecoveryUrl(deep, APP_URL)).toBe(deep)
    const rootWithQuery = 'http://127.0.0.1:54321/?view=compact'
    expect(selectRecoveryUrl(rootWithQuery, APP_URL)).toBe(rootWithQuery)
  })
})

describe('render-process-gone self-healing and circuit breaker', () => {
  it('auto-reloads once after the retry delay, preserving subpath or fragment', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.finishLoad('http://127.0.0.1:54321/#s1')
    contents.rendererGone('oom', -536870904)

    expect(contents.loads).toEqual([APP_URL])
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    expect(contents.loads).toEqual([APP_URL, `${APP_URL}#s1`])
    expect(failures).toEqual([])
  })

  it('preserves a deep same-origin subpath on auto-reload', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    const deep = 'http://127.0.0.1:54321/sessions/42?tab=files'
    contents.finishLoad(deep)
    contents.rendererGone('crashed', 139)

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    expect(contents.loads).toEqual([APP_URL, deep])
    expect(failures).toEqual([])
  })

  it('trips the circuit breaker on a second crash within the crash window and cancels any pending timer', async () => {
    expect(RENDERER_AUTO_RELOAD_MAX).toBe(1)
    expect(RENDERER_CRASH_WINDOW_MS).toBe(60_000)
    const loader = supervise()
    loader.load(APP_URL)
    contents.finishLoad('http://127.0.0.1:54321/')

    // Two crashes back-to-back before the first reload timer even fires.
    contents.rendererGone('crashed', 11)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS / 2)
    contents.rendererGone('oom', 137)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 5)

    expect(contents.loads).toEqual([APP_URL])
    expect(failures).toEqual([RENDERER_GONE_SUMMARY])
    expect(lines).toContain('[desktop] window renderer crashed repeatedly; showing the failure page\n')
    expect(RENDERER_GONE_SUMMARY).not.toMatch(/render-process-gone|OOM|Crashpad|exitCode/iu)
  })

  it('auto-reloads again when the next crash happens outside the 60s window', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.finishLoad('http://127.0.0.1:54321/')

    contents.rendererGone('crashed', 11)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    contents.finishLoad('http://127.0.0.1:54321/')

    await vi.advanceTimersByTimeAsync(RENDERER_CRASH_WINDOW_MS)
    contents.rendererGone('crashed', 11)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

    expect(contents.loads).toEqual([APP_URL, APP_URL, APP_URL])
    expect(failures).toEqual([])
  })

  it('resets the renderer crash budget on a fresh loader.load call', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.finishLoad('http://127.0.0.1:54321/')

    contents.rendererGone('crashed', 11)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    contents.rendererGone('crashed', 11)
    expect(failures).toEqual([RENDERER_GONE_SUMMARY])

    // Manual reload through loader.load restores the auto-reload budget.
    loader.load(APP_URL)
    contents.finishLoad('http://127.0.0.1:54321/')
    contents.rendererGone('crashed', 11)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

    expect(contents.loads).toEqual([APP_URL, APP_URL, APP_URL, APP_URL])
    expect(failures).toHaveLength(1)
  })

  it('resets the network load retry budget when auto-reloading after a renderer crash', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(REFUSED, APP_URL)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    contents.finishLoad('http://127.0.0.1:54321/')

    // First retry was already used during initial load; renderer crash grants a fresh retry.
    contents.rendererGone('crashed', 11)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    contents.failLoad(REFUSED, APP_URL)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

    expect(contents.loads).toEqual([APP_URL, APP_URL, APP_URL, APP_URL])
    expect(failures).toEqual([])
  })

  it('logs but does not reload on clean-exit, before target is set, when destroyed, or while quitting', async () => {
    const loader = supervise()
    // Before any loader.load (`target === undefined`).
    contents.rendererGone('crashed', 11)

    loader.load(APP_URL)
    contents.finishLoad('http://127.0.0.1:54321/')
    contents.rendererGone('clean-exit', 0)

    quitting = true
    contents.rendererGone('killed', 15)
    quitting = false

    contents.destroyed = true
    contents.rendererGone('crashed', 11)
    contents.destroyed = false

    // Quitting raised during the reload wait cancels the actual reload.
    contents.rendererGone('crashed', 11)
    quitting = true
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

    expect(contents.loads).toEqual([APP_URL])
    expect(failures).toEqual([])
    expect(lines.filter(line => line.includes('window renderer gone:'))).toHaveLength(5)
  })
})

describe('preload-error and console-message logging', () => {
  it('logs preload errors by basename with launch tokens redacted and newlines collapsed', () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.emit(
      'preload-error',
      {},
      '/Applications/DSH Desktop.app/Contents/Resources/app.asar/lib/preload.cjs',
      new Error(`boom on http://127.0.0.1:54321/?token=${TOKEN}\nraw=${TOKEN}`),
    )

    expect(lines).toEqual([
      '[desktop] window preload error: preload.cjs: boom on http://127.0.0.1:54321/?token=[redacted] raw=[redacted]\n',
    ])
    expect(lines.join('')).not.toContain(TOKEN)
  })

  it('logs only error-level console messages with sanitized source, redacted tokens, single line, and length cap', () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.consoleMessage({ level: 'debug', message: 'dbg', lineNumber: 1, sourceId: 'http://127.0.0.1:54321/a.js' })
    contents.consoleMessage({ level: 'info', message: 'inf', lineNumber: 2, sourceId: 'http://127.0.0.1:54321/a.js' })
    contents.consoleMessage({ level: 'warning', message: 'wrn', lineNumber: 3, sourceId: 'http://127.0.0.1:54321/a.js' })

    contents.consoleMessage({
      level: 'error',
      message: `failed ?TOKEN=otherSecret&ok=1\r\nleak ${TOKEN}`,
      lineNumber: 42,
      sourceId: `http://127.0.0.1:54321/assets/app.js?token=${TOKEN}#sec`,
    })
    contents.consoleMessage({
      level: 'error',
      message: 'boot failure',
      lineNumber: 0,
      sourceId: 'data:text/html;charset=utf-8,<html>',
    })
    contents.consoleMessage({
      level: 'error',
      message: 'x'.repeat(CONSOLE_ERROR_MAX_CHARS + 50),
      lineNumber: 7,
      sourceId: 'not-a-url',
    })

    expect(lines).toEqual([
      '[desktop] window console error (http://127.0.0.1:54321/assets/app.js:42): failed ?TOKEN=[redacted]&ok=1 leak [redacted]\n',
      '[desktop] window console error (boot page): boot failure\n',
      `[desktop] window console error ((unparsable source, 9 characters):7): ${'x'.repeat(CONSOLE_ERROR_MAX_CHARS - 1)}…\n`,
    ])
    expect(lines.join('')).not.toContain(TOKEN)
    expect(lines.join('')).not.toContain('otherSecret')
  })

  it('rate-limits console error logging per window and reports suppressed counts in the next window', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    for (let index = 1; index <= CONSOLE_ERROR_MAX_PER_WINDOW + 5; index++) {
      contents.consoleMessage({
        level: 'error',
        message: `err-${String(index)}`,
        lineNumber: index,
        sourceId: 'http://127.0.0.1:54321/main.js',
      })
    }

    // 20 logged errors + 1 rate-limit notice.
    expect(lines).toHaveLength(CONSOLE_ERROR_MAX_PER_WINDOW + 1)
    expect(lines.at(-1)).toBe(
      `[desktop] window console error rate limit reached (${String(CONSOLE_ERROR_MAX_PER_WINDOW)} per ${String(CONSOLE_ERROR_WINDOW_MS / 1000)}s); suppressing further errors until the next window\n`,
    )

    await vi.advanceTimersByTimeAsync(CONSOLE_ERROR_WINDOW_MS)
    contents.consoleMessage({
      level: 'error',
      message: 'after-window',
      lineNumber: 99,
      sourceId: 'http://127.0.0.1:54321/main.js',
    })

    expect(lines.slice(-2)).toEqual([
      '[desktop] suppressed 5 window console error(s) in the previous rate-limit window\n',
      '[desktop] window console error (http://127.0.0.1:54321/main.js:99): after-window\n',
    ])
  })
})
