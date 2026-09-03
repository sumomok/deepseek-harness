/**
 * The Electron half of the login route: one visible `BrowserWindow` per
 * sign-in, opened on a named persistent partition and destroyed when the user
 * closes it.
 *
 * This is the one window in the shell a page's own session survives. A render
 * window holds a fresh in-memory partition that dies with it
 * ([[@deepseek-ai/dsh-desktop/render-window]]); this window holds
 * `persist:dsh-render-login-<registrable-domain>`, so the cookies a site sets
 * while the user signs in are still there for the capture that follows and for
 * the next one. What that store holds is Chromium's own encrypted profile data
 * under the app's userData directory: nothing in this process reads a cookie
 * value out of it, and no route returns one.
 *
 * The window is opened only for a nonce the service minted for an exact
 * (url, partition) pair, so nothing here decides which site a user is shown a
 * sign-in for — the protocol half does, in
 * [[@deepseek-ai/dsh-desktop/render-service]], which is also where the
 * partition grammar and the window's own shape are stated so the protocol suite
 * can check them without a display.
 *
 * ## What is relaxed, and what is not
 *
 * A render window locks five things down. Four of them stay locked here,
 * because a sign-in needs none of them: permission requests and permission
 * checks are still refused, downloads are still refused, and the page is still
 * muted. The fifth — every window the page tries to open — is relaxed the
 * narrow way: a popup becomes a navigation of this same window instead of
 * being dropped, which is what carries an OAuth hand-off through to the
 * identity provider and back. A second window is never opened, because the
 * title strip below names one origin and a second window would carry none, and
 * because `resizable` is what tells the app's own window apart from every other
 * ([[@deepseek-ai/dsh-desktop/main-window]]).
 *
 * Dialogs are enabled, because `alert()` and `confirm()` are how a real sign-in
 * page reports a wrong password or a second factor, and this window — unlike a
 * render window — is one the user is looking at and asked for. Devtools stay
 * off, and `sandbox`, `contextIsolation`, and the absence of Node integration
 * are untouched.
 *
 * ## The title strip
 *
 * The window title is locked to the origin the user is actually on, on every
 * event that can change it: `did-navigate`, `did-redirect-navigation`,
 * `did-navigate-in-page`, and `page-title-updated`, whose default the strip
 * cancels so the page cannot write its own title. A user typing a password has
 * to be able to see which site is asking, and a page that can name the window
 * can claim to be a different one.
 * @module @deepseek-ai/dsh-desktop/login-window
 */

import { BrowserWindow, session } from 'electron'
import { LOGIN_WINDOW, loginPartitionDomain } from './render-service.ts'
import type { ClearLoginSession, LoginOpener } from './render-service.ts'

/**
 * The origin the title strip names, for a URL Chromium reports mid-flight.
 * @param url - the window's current URL, which is empty before the first navigation.
 * @returns the origin, or the raw value when it does not parse as a URL.
 */
export function originStrip(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    // `about:blank` between navigations, and the empty string before the
    // first one: neither names an origin, and the raw value is what the strip
    // can honestly show for it.
    return url
  }
}

/**
 * Whether one URL is on the site this sign-in belongs to.
 * @param url - the URL a popup or navigation named.
 * @param domain - the registrable domain the partition is keyed by.
 * @returns true when the URL's host is that domain or a subdomain of it.
 */
export function sameSite(url: string, domain: string): boolean {
  let host: string
  try {
    // The hostname without its port, which is what a partition is keyed by and
    // what the protocol half compares a grant's URL against.
    host = new URL(url).hostname.toLowerCase()
  } catch {
    // A `javascript:` or `blob:` target a page asked to open in a window; it
    // names no host, so it is not this site.
    return false
  }
  return host === domain || host.endsWith(`.${domain}`)
}

/**
 * Lock the window title to the origin the user is on.
 * @param window - the login window.
 */
function lockTitleToOrigin(window: BrowserWindow): void {
  const apply = (): void => {
    if (window.isDestroyed()) return
    window.setTitle(originStrip(window.webContents.getURL()))
  }
  window.webContents.on('did-navigate', apply)
  window.webContents.on('did-navigate-in-page', apply)
  window.webContents.on('did-redirect-navigation', apply)
  window.webContents.on('page-title-updated', (event) => {
    event.preventDefault()
    apply()
  })
  apply()
}

/**
 * Open a visible sign-in window and resolve when the user closes it.
 *
 * The window is destroyed on every exit — the close, the service's abort, and
 * a load failure — because it is an operating-system resource nothing else in
 * this process holds a reference to. A load failure is not an error: a user
 * who reaches a site that is down closes the window, and the capture that
 * follows renders whatever the partition now holds, which is what the tool
 * result then says.
 * @param request - the nonce-backed sign-in: where to open and which partition to store it in.
 * @param signal - aborted when the service's login deadline passes or the shell quits.
 * @returns where the window was when it closed.
 * @throws when the window cannot be opened at all.
 */
export const openLoginWindow: LoginOpener = async (request, signal) => {
  const domain = loginPartitionDomain(request.partition)
  const window = new BrowserWindow({
    ...LOGIN_WINDOW,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: false,
      // Relaxed for this window alone: a sign-in page reports a wrong password
      // or a missing second factor through `alert()` and `confirm()`, and the
      // user is looking at this window rather than at a hidden render.
      disableDialogs: false,
      partition: request.partition,
    },
  })
  const destroy = (): void => {
    if (!window.isDestroyed()) window.destroy()
  }
  signal.addEventListener('abort', destroy, { once: true })
  try {
    // The four render-window lockdowns a sign-in does not need relaxed. A page
    // that wants the camera, the clipboard, or a file on disk while the user
    // types a password is not doing the sign-in.
    const windowSession = window.webContents.session
    windowSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    windowSession.setPermissionCheckHandler(() => false)
    windowSession.on('will-download', (event) => { event.preventDefault() })
    window.webContents.setAudioMuted(true)
    // The one relaxation: a popup this page asks for becomes a navigation of
    // this window. A second window would carry no title strip and would be
    // indistinguishable from the app's own window by `isResizable()`, so the
    // hand-off is followed here instead of being opened beside us — which is
    // also what keeps one origin on screen at a time.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (!window.isDestroyed()) void window.loadURL(url).catch(() => {
        // A hand-off target that refuses to load leaves the user on the page
        // they were on, with the strip still naming it; there is nothing to
        // report to, the window being the whole interface here.
      })
      return { action: 'deny' }
    })
    lockTitleToOrigin(window)
    const closed = new Promise<void>((resolve) => { window.once('closed', () => { resolve() }) })
    // A sign-in wall that is itself unreachable still opens the window: the
    // user sees Chromium's own error page, with the strip naming the site, and
    // closes it.
    await window.loadURL(request.url).catch(() => undefined)
    window.show()
    const landedUrl = await new Promise<string>((resolve) => {
      // Read before `closed` fires: the web contents are gone by then.
      const track = (): void => {
        if (window.isDestroyed()) return
        last = window.webContents.getURL()
      }
      let last = window.isDestroyed() ? request.url : window.webContents.getURL()
      if (!window.isDestroyed()) {
        window.webContents.on('did-navigate', track)
        window.webContents.on('did-navigate-in-page', track)
      }
      void closed.then(() => { resolve(last === '' ? request.url : last) })
    })
    return { landedUrl, sameSite: sameSite(landedUrl, domain) }
  } finally {
    signal.removeEventListener('abort', destroy)
    destroy()
  }
}

/**
 * Erase everything one login partition holds.
 *
 * `clearStorageData` covers the cookies, the caches, and every storage backend
 * Chromium keeps for a partition, which is what "sign out" has to mean for a
 * store this process never reads.
 * @param partition - the login partition to clear, already checked against the protocol's grammar.
 * @returns resolves once the partition is empty.
 */
export const clearLoginSession: ClearLoginSession = async (partition) => {
  await session.fromPartition(partition).clearStorageData()
}
