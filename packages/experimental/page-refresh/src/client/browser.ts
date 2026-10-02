/**
 * The browser half's one contact with the page's global objects. Everything
 * impure it does — reading the navigation entry and the boot global, fetching
 * the served index, reading and writing session storage, reloading, waiting for
 * a clock, and listening for the page returning to the foreground or the network
 * coming back — passes through {@link PageRefreshBrowser}, so the build check
 * and the connection notices are exercised without a page and every path is
 * reachable from a test.
 * @module @deepseek-ai/dsh-experimental-page-refresh/src/client/browser
 */

/** The answer to one request for the served index. */
export interface ServedDocument {
  /** HTTP status; `0` for the opaque answer a manual-redirect request gets for a redirect. */
  readonly status: number
  /** The `content-type` header, or `null` when the answer carries none. */
  readonly contentType: string | null
  /**
   * Read the body as text.
   * @returns the body.
   */
  text(): Promise<string>
}

/** The browser operations the build check and the connection notices perform. */
export interface PageRefreshBrowser {
  /**
   * The URL of this document's navigation entry, which keeps the address the
   * document was served from whatever the page later does to its location.
   * @returns that URL, or `undefined` when the page records no navigation entry.
   */
  navigationUrl(): string | undefined
  /** The page's current address. */
  currentHref(): string
  /**
   * The boot graph this document booted with, as the served index assigned it.
   * @returns `window.__DSH_BOOT__`, unvalidated.
   */
  bootGraph(): unknown
  /**
   * Absolute URLs of this document's module scripts — the web shell's own
   * bundle, whose file name carries its build hash.
   * @returns the URLs, sorted.
   */
  moduleScripts(): string[]
  /**
   * Absolute URLs of the module scripts in one served index.
   * @param html - the index body.
   * @param url - the address it was served from, which its relative URLs and
   * its `<base href>` resolve against.
   * @returns the URLs, sorted.
   */
  moduleScriptsIn(html: string, url: string): string[]
  /**
   * Request the index the document was served from, bypassing every cache and
   * following no redirect.
   * @param url - the document URL.
   * @param signal - aborts the request when the check is superseded or disposed.
   * @returns the answer.
   * @throws {Error} when the request fails or is aborted.
   */
  fetchDocument(url: string, signal: AbortSignal): Promise<ServedDocument>
  /**
   * One value out of this tab's session storage.
   * @param key - the storage key.
   * @returns the stored value, or `null` when nothing is stored under it.
   * @throws {Error} when the page may not use session storage.
   */
  readSession(key: string): string | null
  /**
   * Store one value in this tab's session storage.
   * @param key - the storage key.
   * @param value - the value.
   * @throws {Error} when the page may not use session storage or it is full.
   */
  writeSession(key: string, value: string): void
  /**
   * Remove one value from this tab's session storage.
   * @param key - the storage key.
   * @throws {Error} when the page may not use session storage.
   */
  removeSession(key: string): void
  /** Load the current document again. */
  reload(): void
  /**
   * Run something once, later.
   * @param delayMs - how long to wait, at most a browser timer's longest delay.
   * @param run - what to run.
   * @returns the disposer cancelling it.
   */
  schedule(delayMs: number, run: () => void): () => void
  /**
   * Subscribe to the page returning to the foreground.
   * @param listener - called each time the page becomes visible.
   * @returns the disposer removing the subscription.
   */
  onVisible(listener: () => void): () => void
  /** Whether the browser reports a network connection. */
  online(): boolean
  /**
   * Subscribe to the browser gaining or losing its network connection.
   * @param listener - called after each change; it reads {@link online} itself.
   * @returns the disposer removing the subscription.
   */
  onOnlineChange(listener: () => void): () => void
}

/**
 * The page globals {@link windowPageRefreshBrowser} reads, named one by one so
 * the window-backed browser runs against a page assembled by a test as well as
 * against `window`.
 */
export interface PageGlobals {
  readonly location: Pick<Location, 'href' | 'reload'>
  readonly sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  readonly performance: Pick<Performance, 'getEntriesByType'>
  readonly document: Pick<Document, 'baseURI' | 'visibilityState' | 'querySelectorAll' | 'addEventListener' | 'removeEventListener'>
  readonly navigator: Pick<Navigator, 'onLine'>
  readonly DOMParser: new () => Pick<DOMParser, 'parseFromString'>
  /** The boot graph the served index assigned. */
  readonly __DSH_BOOT__?: unknown
  fetch(input: string, init: RequestInit): Promise<Response>
  setTimeout(run: () => void, delayMs: number): number
  clearTimeout(id: number): void
  addEventListener(type: 'online' | 'offline', listener: () => void): void
  removeEventListener(type: 'online' | 'offline', listener: () => void): void
}

/**
 * Absolute URLs of every module script that names its source under one
 * document root. An inline module script names none and is not part of the
 * build's identity.
 * @param root - the document to read.
 * @param base - the URL relative sources resolve against.
 * @returns the URLs, sorted.
 */
export function moduleScriptsOf(root: Pick<ParentNode, 'querySelectorAll'>, base: string): string[] {
  return [...root.querySelectorAll('script[type="module"]')].flatMap((script) => {
    const src = script.getAttribute('src')
    return src === null ? [] : [new URL(src, base).href]
  }).sort()
}

/**
 * Absolute URLs of the module scripts in one parsed index. The served index
 * carries `<base href="./">`, so its module sources resolve against that base,
 * which itself resolves against the address the index was served from.
 * @param parsed - the parsed index.
 * @param url - the address it was served from.
 * @returns the URLs, sorted.
 */
export function moduleScriptsInIndex(parsed: Pick<ParentNode, 'querySelector' | 'querySelectorAll'>, url: string): string[] {
  const baseHref = parsed.querySelector('base[href]')?.getAttribute('href')
  return moduleScriptsOf(parsed, baseHref === undefined || baseHref === null ? url : new URL(baseHref, url).href)
}

/**
 * The page-refresh browser, backed by the page's own globals.
 * @param page - the globals to read; `window` in a page.
 * @returns the operations bound to those globals.
 */
export function windowPageRefreshBrowser(page: PageGlobals): PageRefreshBrowser {
  return {
    navigationUrl: () => page.performance.getEntriesByType('navigation')[0]?.name,
    currentHref: () => page.location.href,
    bootGraph: () => page.__DSH_BOOT__,
    moduleScripts: () => moduleScriptsOf(page.document, page.document.baseURI),
    moduleScriptsIn: (html, url) => moduleScriptsInIndex(new page.DOMParser().parseFromString(html, 'text/html'), url),
    fetchDocument: async (url, signal) => {
      // Same-origin credentials carry the browser session cookie the index is
      // authorized with; a manual redirect turns the launch-token exchange's
      // redirect, or any other, into a status the check refuses.
      const response = await page.fetch(url, { cache: 'no-store', redirect: 'manual', credentials: 'same-origin', signal })
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        text: () => response.text(),
      }
    },
    readSession: key => page.sessionStorage.getItem(key),
    writeSession: (key, value) => { page.sessionStorage.setItem(key, value) },
    removeSession: (key) => { page.sessionStorage.removeItem(key) },
    reload: () => { page.location.reload() },
    schedule: (delayMs, run) => {
      const timer = page.setTimeout(run, delayMs)
      return () => { page.clearTimeout(timer) }
    },
    onVisible: (listener) => {
      const onChange = (): void => {
        if (page.document.visibilityState === 'visible') listener()
      }
      page.document.addEventListener('visibilitychange', onChange)
      return () => { page.document.removeEventListener('visibilitychange', onChange) }
    },
    online: () => page.navigator.onLine,
    onOnlineChange: (listener) => {
      page.addEventListener('online', listener)
      page.addEventListener('offline', listener)
      return () => {
        page.removeEventListener('online', listener)
        page.removeEventListener('offline', listener)
      }
    },
  }
}
