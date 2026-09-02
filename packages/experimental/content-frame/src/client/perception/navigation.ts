/**
 * Watching one frame for the application inside it moving.
 *
 * A configured page is a shell around somebody else's application, and that
 * application routes itself: the user clicks its menu, it redirects after a
 * sign-in, it replaces a table with a detail view. None of that touches the
 * page id the column recorded, so without this watch the agent's picture of the
 * column is right about which application is on screen and wrong about
 * everything inside it.
 *
 * Four signals, one answer. `load` covers a whole document being replaced,
 * `hashchange` covers a hash router, `popstate` covers the back button — and
 * none of the three fires for `history.pushState`, which is how every current
 * router changes route in history mode. What covers that is polling the frame's
 * own address, which is also the one method that needs nothing of the page:
 * patching `history.pushState` inside the frame would reach into a document
 * this package does not own, and an application wrapping it afterwards would
 * take the patch back out.
 *
 * Everything the four signals produce goes through one settling window before
 * anything is reported, because a router writes the address first and the
 * document title on the next paint, and because two of them fire together for
 * one move. What comes out is compared against the last address reported for
 * that frame, so a page that oscillates between two states reports each change
 * once and a page that does not move reports nothing.
 *
 * Cross-origin is out of scope by construction and silent by design: a frame
 * that has left the dsh origin answers every read here with a SecurityError,
 * and the watch reports nothing rather than failing a read the user never asked
 * for.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/perception/navigation
 */

import { MAX_HEADER_CHARS, sanitize } from '../../access/wire.ts'

/**
 * How long a frame must hold still before its address is reported.
 *
 * A protocol constant, not a deployment choice: it bounds one debounce between
 * a router's own two writes — the address, then the title — and no deployment
 * observes a different browser.
 */
export const NAVIGATION_SETTLE_MS = 300

/** Where one frame is, as this watch reports it. */
export interface FrameAddress {
  /** Path, query and fragment inside the page; the origin is always the dsh one. */
  readonly url: string
  /** The document's title, cut to what the log carries; empty when it has none. */
  readonly title: string
}

/** One frame's watch, driven by the seat that owns the element. */
export interface FrameWatch {
  /**
   * Re-arm on the document that just loaded. A navigation replaces the frame's
   * inner window, and listeners registered on the previous one went with it.
   */
  reload: () => void
  /** Read the frame's address; a change from the last one seen starts the settling window. */
  poll: () => void
  /** Stop watching. Every later signal is inert. */
  dispose: () => void
}

/** What one frame's watch needs from the seat. */
export interface FrameWatchOptions {
  /** The frame element to watch. */
  readonly frame: HTMLIFrameElement
  /**
   * The page's own configured address. A frame that loads and stays there has
   * not moved, and reporting it would put the page's own entry point in the log
   * as a navigation.
   */
  readonly entryUrl: string
  /** Called once per settled move, with where the frame ended up. */
  readonly onNavigated: (address: FrameAddress) => void
}

/**
 * Remove one listener, tolerating a window that has since gone cross-origin.
 * @param view - the frame's inner window as it was when the listener was added.
 * @param type - the event name.
 * @param listener - the listener to remove.
 */
function drop(view: Window, type: string, listener: () => void): void {
  try {
    view.removeEventListener(type, listener)
  } catch (_windowNoLongerReachable) {
    // A frame that navigated to another origin answers every access with a
    // SecurityError. Its listeners went with the document that held them.
  }
}

/**
 * Cut one title to what the log carries, at a boundary that keeps it
 * well-formed.
 *
 * The cut is walked back off a surrogate pair rather than through it: the
 * command that records this refuses a lone surrogate half, and a cut that left
 * one would lose the whole event it exists to save.
 * @param value - the document's title as the page wrote it.
 * @returns the title as the command receives it.
 */
function clipTitle(value: string): string {
  const printable = sanitize(value)
  if (printable.length <= MAX_HEADER_CHARS) return printable
  let cut = MAX_HEADER_CHARS - 1
  while (cut > 0 && !printable.slice(0, cut).isWellFormed()) cut -= 1
  return `${printable.slice(0, cut)}…`
}

/**
 * Read where one frame is now.
 * @param frame - the frame element.
 * @returns the address, or `undefined` when the frame has no window or has left this origin.
 */
function addressOf(frame: HTMLIFrameElement): FrameAddress | undefined {
  const view = frame.contentWindow
  if (view === null) return undefined
  try {
    const at = view.location
    return { url: `${at.pathname}${at.search}${at.hash}`, title: clipTitle(view.document.title) }
  } catch (_frameLeftThisOrigin) {
    // The premise of this whole package is a same-origin frame; one that is not
    // is a frame nothing here can read, and saying so is not this watch's job.
    return undefined
  }
}

/**
 * Watch one frame for the application inside it moving.
 * @param options - the frame, the address it was opened at, and where moves go.
 * @returns the watch, for the seat to drive and dispose.
 */
export function watchFrame(options: FrameWatchOptions): FrameWatch {
  /** Where the last report said the frame was; absent until one is made. */
  let reported: FrameAddress | undefined
  /** The address the last poll read, which is what makes a poll cheap. */
  let polled: string | undefined
  let settling: ReturnType<typeof setTimeout> | undefined
  let detach: (() => void) | undefined
  let disposed = false

  const check = (): void => {
    settling = undefined
    const at = addressOf(options.frame)
    if (at === undefined) return
    if (reported !== undefined && reported.url === at.url && reported.title === at.title) return
    // A first load that stopped at the page's own address is the page being
    // opened, which the log already records as `content/shown`.
    if (reported === undefined && at.url === options.entryUrl) return
    reported = at
    options.onNavigated(at)
  }

  const arm = (): void => {
    if (disposed) return
    clearTimeout(settling)
    settling = setTimeout(check, NAVIGATION_SETTLE_MS)
  }

  const listen = (): void => {
    detach?.()
    detach = undefined
    const view = options.frame.contentWindow
    if (view === null) return
    const onMove = (): void => { arm() }
    try {
      view.addEventListener('hashchange', onMove)
    } catch (_frameLeftThisOrigin) {
      // Same premise as `addressOf`: nothing to watch, nothing to say.
      return
    }
    view.addEventListener('popstate', onMove)
    detach = () => {
      drop(view, 'hashchange', onMove)
      drop(view, 'popstate', onMove)
    }
  }

  listen()
  return {
    reload: () => {
      if (disposed) return
      listen()
      arm()
    },
    poll: () => {
      if (disposed) return
      const at = addressOf(options.frame)
      if (at === undefined || at.url === polled) return
      polled = at.url
      arm()
    },
    dispose: () => {
      disposed = true
      clearTimeout(settling)
      settling = undefined
      detach?.()
      detach = undefined
    },
  }
}
