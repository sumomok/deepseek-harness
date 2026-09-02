/**
 * What the page did on its own while the steps ran, and the two functions this
 * package stands in for while they run.
 *
 * A step is one event dispatched at one element; everything the application
 * does in answer to it — a toast, a route change, a confirmation box, a window
 * it tries to open — happens afterwards and would otherwise reach nobody. The
 * closing snapshot cannot recover most of it: a toast that came and went leaves
 * nothing to read, and a `confirm()` nobody answered would have stopped the
 * call dead.
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
import { dialogLine, messageLine, navigationLine, windowLine, type ActPageEvent } from '../../access/act-text.ts'
import { clipTo, collapse, isSkipped, visibleText } from './dom.ts'

/**
 * How many things one call reports the page doing. A protocol bound: an
 * application that redraws a list while the steps run can add hundreds of
 * nodes, and the model needs to know a toast appeared, not to read the
 * application's whole render log.
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
  /** Everything the page did on its own, oldest first, at most {@link MAX_EVENTS}. */
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

/** Text that appeared while the steps ran, waiting to see whether it goes away. */
interface Appearance {
  /** The node that carries it. */
  readonly node: Node
  /** What it says, already cut to {@link MAX_EVENT_CHARS}. */
  readonly text: string
  /** When it appeared, as a `Date.now()` value. */
  readonly at: number
}

/**
 * The visible text one added node contributes, if any.
 * @param node - the node the page added.
 * @param isVisible - injected visibility, the reader's own.
 * @returns the text, or undefined for a node that shows none.
 */
function addedText(node: Node, isVisible: (el: Element) => boolean): string | undefined {
  if (node.nodeType === node.TEXT_NODE) {
    const text = collapse((node as Text).data)
    return text === '' ? undefined : text
  }
  if (node.nodeType !== node.ELEMENT_NODE) return undefined
  const el = node as Element
  if (isSkipped(el, isVisible)) return undefined
  const text = visibleText(el, isVisible)
  return text === '' ? undefined : text
}

/**
 * Watch the page for the length of a call, and answer its dialogs.
 *
 * What counts as a message is text that appeared and then went away on its own:
 * a toast, a validation line, a "saved" banner. Text that appeared and stayed
 * is in the closing snapshot already, and reporting it twice would tell the
 * model nothing it is not about to read.
 * @param docs - every same-origin document the reader walked, the frame's own first.
 * @param dialogs - how a native dialog is to be answered.
 * @param isVisible - injected visibility, the reader's own.
 * @returns the live watch.
 */
export function watchPage(
  docs: readonly Document[],
  dialogs: DialogAnswer,
  isVisible: (el: Element) => boolean,
): ActWatch {
  const collected: ActPageEvent[] = []
  const appeared: Appearance[] = []
  const push = (event: ActPageEvent): void => {
    if (collected.length < MAX_EVENTS) collected.push(event)
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const text = addedText(node, isVisible)
        if (text !== undefined) appeared.push({ node, text: clipTo(text, MAX_EVENT_CHARS), at: Date.now() })
      }
      for (const node of record.removedNodes) {
        const at = appeared.findIndex(candidate => candidate.node === node || node.contains(candidate.node))
        if (at === -1) continue
        const [gone] = appeared.splice(at, 1)
        /* v8 ignore next -- splice at a found index always yields the entry. */
        if (gone === undefined) continue
        push({ kind: 'message', line: messageLine(gone.text, Date.now() - gone.at) })
      }
    }
  })

  const routes: (() => void)[] = []
  const restores: (() => void)[] = []
  for (const doc of docs) {
    const view = doc.defaultView
    /* v8 ignore next 2 -- every document the reader walked is mounted in the seat's own frame, which has a window. */
    if (view === null) continue
    observer.observe(doc, { subtree: true, childList: true })
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
      observer.disconnect()
      for (const restore of restores) restore()
    },
  }
}
