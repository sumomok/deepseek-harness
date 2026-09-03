/**
 * What the page did on its own while the steps ran, and the two functions this
 * package stands in for while they run.
 *
 * A step is one event dispatched at one element; what the browser itself does
 * in answer to it — a confirmation box, a route change, a window the page tries
 * to open — happens afterwards and would otherwise reach nobody. The closing
 * snapshot cannot recover any of it: a route the page moved along and came back
 * from is in no read, and a `confirm()` nobody answered would have stopped the
 * call dead. What the page merely draws is left to that closing read, which is
 * what a read is for.
 *
 * Two page functions are replaced for the length of the act window and put back
 * after it, which is the whole of what this package injects into the documents
 * it shares an origin with. `confirm`/`alert`/`prompt` are replaced because
 * they block that document's event loop until something answers, and the seat
 * is that something; `window.open` is replaced because a window opened behind
 * the console is a window nobody will ever look at, so the attempt is reported
 * instead of made. Both are restored even where a step threw, because a frame
 * left with this package's stand-ins is a frame whose own dialogs never open
 * again.
 *
 * Every document the reader walked is watched, not the frame's own alone: a
 * `confirm()` an application opens from inside a frame the page holds blocks
 * the whole tab just the same, and a toast it draws there is as much of an
 * answer to a step. The set is the one the call started with — a frame the
 * page adds while the steps run is not watched, and what it does is left to
 * the closing read.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/watch
 */

import type { DialogAnswer } from '../../access/wire.ts'
import { dialogLine, navigationLine, windowLine, type ActPageEvent } from '../../access/act-text.ts'
import { clipTo, collapse } from './dom.ts'

/**
 * How many things one call reports the page doing. A protocol bound: a page
 * that answers one step with a run of navigations reports the first few of
 * them, and the model reads the page rather than a log of what it did.
 */
const MAX_EVENTS = 8

/**
 * How much of one thing the page did is quoted. A protocol bound, and the same
 * order as the reader's own limit on a text run: what a toast says fits well
 * inside it, and a paragraph that appeared and vanished is named rather than
 * reproduced.
 */
const MAX_EVENT_CHARS = 200

/** One live watch over the frame, for as long as the steps run. */
export interface ActWatch {
  /** Everything the browser did on the page's own account, oldest first, at most {@link MAX_EVENTS}. */
  events: () => ActPageEvent[]
  /** Restore both stand-ins and drop every listener. */
  stop: () => void
}

/** What the page's own dialog functions look like, as a window carries them. */
interface DialogFunctions {
  /** Asks a yes/no question and blocks until it is answered. */
  confirm: Window['confirm']
  /** States something and blocks until it is dismissed. */
  alert: Window['alert']
  /** Asks for a line of text and blocks until it is given or refused. */
  prompt: Window['prompt']
  /** Opens another window. */
  open: Window['open']
}

/**
 * Watch the page for the length of a call, and answer its dialogs.
 *
 * What is watched is what the browser does and no read can recover: the dialogs
 * a page opens, the addresses it moves to, the windows it tries to open. What
 * the page draws in answer to a step is in the closing read, and reading it is
 * how the model finds out what the steps did.
 * @param docs - every same-origin document the reader walked, the frame's own first.
 * @param dialogs - how a native dialog is to be answered.
 * @returns the live watch.
 */
export function watchPage(docs: readonly Document[], dialogs: DialogAnswer): ActWatch {
  const collected: ActPageEvent[] = []
  const push = (event: ActPageEvent): void => {
    if (collected.length < MAX_EVENTS) collected.push(event)
  }

  const routes: (() => void)[] = []
  const restores: (() => void)[] = []
  for (const doc of docs) {
    const view = doc.defaultView
    /* v8 ignore next 2 -- every document the reader walked is mounted in the seat's own frame, which has a window. */
    if (view === null) continue
    // The address the document was last reported at, so a router that announces
    // one move with several events is one line rather than three.
    let routed = view.location.href
    const onRoute = (): void => {
      const now = view.location.href
      if (now === routed) return
      routed = now
      push({ kind: 'navigation', line: navigationLine(now) })
    }
    routes.push(onRoute)
    view.addEventListener('hashchange', onRoute)
    view.addEventListener('popstate', onRoute)

    // Capturing, so the anchor's own handlers do not run first: a new window is
    // one the user cannot see, and the model is told the page tried rather than
    // left to wonder why nothing happened.
    const onClick = (event: Event): void => {
      const target = event.target
      if (!(target instanceof view.Element)) return
      const anchor = target.closest('a[target]')
      if (anchor === null) return
      const where = anchor.getAttribute('target')
      if (where !== '_blank' && where !== '_new') return
      event.preventDefault()
      push({ kind: 'window', line: windowLine(clipTo(anchor.getAttribute('href') ?? '', MAX_EVENT_CHARS)) })
    }
    doc.addEventListener('click', onClick, true)

    // Held unbound, because these are put back on the window they came off: a
    // bound copy would restore a function the page can tell apart from its own.
    const original: DialogFunctions = {
      confirm: view.confirm,
      alert: view.alert,
      prompt: view.prompt,
      open: view.open,
    }
    const answered = (kind: string, message?: string): void => {
      push({ kind: 'dialog', line: dialogLine(kind, clipTo(collapse(message ?? ''), MAX_EVENT_CHARS), dialogs) })
    }
    view.confirm = (message?: string): boolean => {
      answered('confirm', message)
      return dialogs === 'accept'
    }
    view.alert = (message?: string): void => { answered('alert', message) }
    view.prompt = (message?: string, fallback?: string): string | null => {
      answered('prompt', message)
      return dialogs === 'accept' ? fallback ?? '' : null
    }
    view.open = (url?: string | URL): Window | null => {
      push({ kind: 'window', line: windowLine(clipTo(String(url ?? ''), MAX_EVENT_CHARS)) })
      return null
    }

    restores.push(() => {
      view.removeEventListener('hashchange', onRoute)
      view.removeEventListener('popstate', onRoute)
      doc.removeEventListener('click', onClick, true)
      view.confirm = original.confirm
      view.alert = original.alert
      view.prompt = original.prompt
      view.open = original.open
    })
  }

  return {
    events: () => {
      // The address is compared as well as listened for: `pushState` fires no
      // event a listener can hear, and a whole-page navigation takes the
      // listeners with it.
      for (const onRoute of routes) onRoute()
      return [...collected]
    },
    stop: () => {
      for (const restore of restores) restore()
    },
  }
}
