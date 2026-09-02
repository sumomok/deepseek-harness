/**
 * What the page did on its own while the steps ran, and the two functions this
 * package stands in for while they run.
 *
 * A step is one event dispatched at one element; everything the application
 * does in answer to it — a toast, a route change, a confirmation box, a window
 * it tries to open — happens afterwards and would otherwise reach nobody. The
 * closing snapshot cannot recover most of it: a toast that came and went leaves
 * nothing to read, one still on the screen is not marked as an answer to
 * anything, and a `confirm()` nobody answered would have stopped the call
 * dead.
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
import { clipTo, collapse, isHiddenAround, visibleText } from './dom.ts'

/**
 * How many things one call reports the page doing. A protocol bound: an
 * application that redraws a list while the steps run can add hundreds of
 * nodes, and the model needs to know a toast appeared, not to read the
 * application's whole render log. It is also what bounds the work: once this
 * many lines are collected nothing further can be reported, and the watch stops
 * looking.
 */
const MAX_EVENTS = 8

/**
 * How many nodes the watch follows at once. A protocol bound of the same
 * family: it reports at most {@link MAX_EVENTS} of them, so following more than
 * a few times that many buys nothing and costs one visible-text computation per
 * node per burst of page activity.
 */
const MAX_TRACKED = 32

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

/** One node the watch is following, and what the user could last read on it. */
interface Tracked {
  /** The element carrying the text; a text node is followed through its parent. */
  readonly el: Element
  /** What it showed at the last look, already cut to {@link MAX_EVENT_CHARS}; empty when it showed nothing. */
  text: string
  /** When it started showing that, as a `Date.now()` value. */
  at: number
  /**
   * Whether what it shows now started while the steps ran. Text the watch found
   * already on the page is not a message — it is what the page said before the
   * call, and the closing read is where the model sees it.
   */
  born: boolean
}

/** The attributes a page hides and reveals text with, which the watch listens for. */
const VISIBILITY_ATTRIBUTES = ['hidden', 'class', 'style', 'aria-hidden']

/**
 * The element one mutated node's text belongs to.
 * @param node - the node the record named.
 * @returns the element, or undefined for a node that carries no text of its own.
 */
function elementOf(node: Node): Element | undefined {
  if (node.nodeType === node.ELEMENT_NODE) return node as Element
  if (node.nodeType === node.TEXT_NODE) return node.parentElement ?? undefined
  return undefined
}

/**
 * What a user could read on one element at this instant.
 *
 * Visible text rather than the document's own, and the element's own placement
 * as well as its contents: a page keeps its toasts in the markup and hides
 * them, so what makes a message is the moment it can be read, not the moment it
 * was written.
 * @param el - the element to look at.
 * @param isVisible - injected visibility, the reader's own.
 * @returns the text, empty when the element shows none.
 */
function shownText(el: Element, isVisible: (el: Element) => boolean): string {
  if (!el.isConnected || isHiddenAround(el, isVisible)) return ''
  return clipTo(visibleText(el, isVisible), MAX_EVENT_CHARS)
}

/**
 * Whether one attribute change may have put text in front of the user.
 *
 * `hidden` and `aria-hidden` answer for themselves, because the record carries
 * what they held before. What a class or an inline style drew cannot be read
 * back once it has changed, and revealing a message is what a page uses them
 * for, so both count: an element whose class changed and which shows text is
 * read as having just been given that text to show. The cost of taking it that
 * way is a page that restyles something it was already showing, which spends
 * one of the {@link MAX_EVENTS} lines on text the closing read shows anyway;
 * the cost of the other way is missing every framework's own reveal.
 * @param record - the attribute record.
 * @returns whether the element may have just been revealed.
 */
function reveals(record: MutationRecord): boolean {
  if (record.attributeName === 'hidden') return record.oldValue !== null
  if (record.attributeName === 'aria-hidden') return record.oldValue === 'true'
  return true
}

/**
 * Watch the page for the length of a call, and answer its dialogs.
 *
 * What counts as a message is text a user could read that was not readable
 * before: a toast, a validation line, a "saved" banner. When it becomes
 * readable is what decides, not when it was written — a page writes its toast
 * into a hidden box and then shows the box, and the words were on no screen in
 * between. It is reported when it goes away, with how long it stayed, and at
 * the end of the call when it has not gone: the closing read shows what is
 * still there but never says the steps produced it.
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
  const tracked: Tracked[] = []
  const push = (event: ActPageEvent): void => {
    if (collected.length < MAX_EVENTS) collected.push(event)
  }

  // Followed from here on. A node the page added, text it rewrote in place, and
  // an element an attribute change may have revealed all start from nothing:
  // whatever they show, the user is reading it because of something that
  // happened during this call. An element the same attributes have just hidden
  // starts from what it shows, which is nothing, so a later reveal is caught
  // and what it showed before the call is not reported as having appeared.
  const follow = (node: Node, fresh: boolean): void => {
    const el = elementOf(node)
    if (el === undefined || tracked.length >= MAX_TRACKED) return
    if (tracked.some(candidate => candidate.el === el)) return
    tracked.push({ el, text: fresh ? '' : shownText(el, isVisible), at: Date.now(), born: false })
  }

  // Every followed node, because a change anywhere can hide or reveal what
  // another one carries: an ancestor going `hidden` takes its whole subtree
  // with it, and a node removed with its parent is reported by neither record.
  const review = (): void => {
    for (const candidate of tracked) {
      const now = shownText(candidate.el, isVisible)
      if (now === candidate.text) continue
      if (candidate.text !== '' && candidate.born) {
        push({ kind: 'message', line: messageLine(candidate.text, Date.now() - candidate.at) })
      }
      candidate.text = now
      candidate.at = Date.now()
      candidate.born = now !== ''
    }
  }

  const observer = new MutationObserver((records) => {
    // Nothing further can be reported once the bound is reached, so nothing
    // further is computed either.
    if (collected.length >= MAX_EVENTS) return
    for (const record of records) {
      for (const node of record.addedNodes) follow(node, true)
      if (record.type === 'characterData') follow(record.target, true)
      if (record.type === 'attributes') follow(record.target, reveals(record))
    }
    review()
  })

  const routes: (() => void)[] = []
  const restores: (() => void)[] = []
  for (const doc of docs) {
    const view = doc.defaultView
    /* v8 ignore next 2 -- every document the reader walked is mounted in the seat's own frame, which has a window. */
    if (view === null) continue
    observer.observe(doc, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: VISIBILITY_ATTRIBUTES,
    })
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
      // One last look, and then what is still in front of the user. A message
      // the page has not taken away yet is in the closing read as well, and the
      // model still needs to be told the steps produced it — which the read
      // alone never says.
      review()
      for (const candidate of tracked) {
        if (candidate.born && candidate.text !== '') {
          push({ kind: 'message', line: messageLine(candidate.text, undefined) })
        }
      }
      return [...collected]
    },
    stop: () => {
      observer.disconnect()
      for (const restore of restores) restore()
    },
  }
}
