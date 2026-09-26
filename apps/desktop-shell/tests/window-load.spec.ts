/**
 * The app window's load supervision against a stand-in for Electron's
 * `WebContents`: which events write which lines, when a failed load of the
 * served UI is retried, and when the failure page is asked for instead.
 * @module
 */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeUrl, ERR_ABORTED, RETRY_DELAY_MS, superviseAppLoad, type WindowContents } from '../src/window-load.ts'

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
}

let contents: FakeContents
let lines: string[]
let failures: string[]

/** Supervise [[contents]], recording into [[lines]] and [[failures]]. */
function supervise(): ReturnType<typeof superviseAppLoad> {
  return superviseAppLoad(contents as unknown as WindowContents, {
    log: (line) => { lines.push(line) },
    giveUp: (summary) => { failures.push(summary) },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  contents = new FakeContents()
  lines = []
  failures = []
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

  it('gets a fresh retry after a load of the served UI succeeded', async () => {
    const loader = supervise()
    loader.load(APP_URL)
    contents.failLoad(REFUSED, APP_URL)
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
    contents.finishLoad('http://127.0.0.1:54321/')
    contents.failLoad(REFUSED, 'http://127.0.0.1:54321/')
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

    expect(contents.loads).toEqual([APP_URL, APP_URL, APP_URL])
    expect(failures).toEqual([])
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
    ])
    expect(lines.join('')).not.toContain(TOKEN)
  })

  it('names the boot page and a string that is not a URL without repeating them', () => {
    expect(describeUrl('data:text/html;charset=utf-8,%3C!doctype%20html%3E')).toBe('boot page')
    expect(describeUrl(`http://127.0.0.1:1/api?token=${TOKEN}#x`)).toBe('http://127.0.0.1:1/api')
    expect(describeUrl('not a url')).toBe('(unparsable URL, 9 characters)')
  })
})
