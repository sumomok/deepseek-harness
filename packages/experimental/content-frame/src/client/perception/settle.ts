/**
 * Waiting for a page to finish drawing itself, and naming what it says is still
 * loading.
 *
 * A read of a frame that just moved is a read of whatever the application had
 * painted at that instant. Waiting for `load` covers a whole-document
 * navigation and nothing else: a route change inside a single-page application
 * fetches its data afterwards, so the document is complete while the table the
 * user is looking at is still empty. What is left is the generic signal — the
 * document stopped changing — and this module is the whole of it.
 *
 * Two answers come out, and both reach the model. Whether the page went quiet
 * decides which sentence the listing opens with, because a read taken while the
 * page was still moving is worth taking again; the elements the page itself
 * marks `aria-busy` are named, because a page that says it is loading has told
 * the model more than the mutation record can. Framework class names
 * (`.el-loading-mask`, `.ant-spin`) are deliberately not recognized — this
 * reader knows no UI library — and `role="progressbar"` is not read as busy
 * either, since a progress bar may be the content itself.
 *
 * The wait is pure of any read: it takes a document and two numbers, so the
 * click-then-read path can spend it the same way this one does.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/perception/settle
 */

import { clipTo, containerName, queryInOrder } from '../access/dom.ts'
import { MAX_BUSY_NAMES } from '../../access/wire.ts'

/**
 * Longest busy element name one listing header prints, in characters. The
 * header names what is loading so the model can say so; the whole label of a
 * long region is not what that costs its tokens on.
 */
const MAX_BUSY_NAME_CHARS = 40

/** Elements a page marks as loading through the one attribute every page can write. */
const BUSY_SELECTOR = '[aria-busy="true"]'

/** What the wait before a read found. */
export interface Settlement {
  /** Whether the document went quiet before the budget ran out. */
  readonly settled: boolean
  /** Names of the visible elements the page marks busy, at most {@link MAX_BUSY_NAMES}. */
  readonly busy: readonly string[]
}

/** How long a read may wait for one document to stop changing. */
export interface SettleBounds {
  /** How long the document must go unchanged before it counts as drawn. */
  readonly quietMs: number
  /** How long the whole wait may take, after which the read proceeds anyway. */
  readonly budgetMs: number
}

/**
 * Wait for one document to stop changing.
 *
 * Every mutation restarts the quiet window, so a page painting in bursts is
 * waited out and a page animating forever is not: the budget ends the wait and
 * the read proceeds on what is there, because a listing of a moving page is
 * still worth more to the model than no listing at all.
 * @param doc - the frame document about to be read.
 * @param bounds - the quiet window and the total budget.
 * @returns whether the document went quiet in time.
 */
export function whenQuiet(doc: Document, bounds: SettleBounds): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let quiet: ReturnType<typeof setTimeout>
    const done = (settled: boolean): void => {
      clearTimeout(quiet)
      clearTimeout(total)
      observer.disconnect()
      resolve(settled)
    }
    const observer = new MutationObserver(() => {
      clearTimeout(quiet)
      quiet = setTimeout(() => { done(true) }, bounds.quietMs)
    })
    const total = setTimeout(() => { done(false) }, bounds.budgetMs)
    observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true })
    quiet = setTimeout(() => { done(true) }, bounds.quietMs)
  })
}

/**
 * Name the visible elements the page marks as loading.
 *
 * The name is the engine's own ladder for a region — what it is labelled, or
 * failing that the first heading inside it — because that is what the model
 * will have to call it when it tells the user. An element with neither is named
 * by its tag, which is the only thing left that is true.
 * @param doc - the frame document.
 * @param isVisible - injected visibility, the reader's own.
 * @returns the names, at most {@link MAX_BUSY_NAMES} of them.
 */
export function busyNames(doc: Document, isVisible: (el: Element) => boolean): string[] {
  return queryInOrder(doc, BUSY_SELECTOR)
    .filter(el => isVisible(el))
    .slice(0, MAX_BUSY_NAMES)
    .map((el) => {
      const named = containerName(el, isVisible)
      return clipTo(named === '' ? el.tagName.toLowerCase() : named, MAX_BUSY_NAME_CHARS)
    })
}

/**
 * Wait for the page to settle, then read what it says is still loading.
 *
 * The busy scan runs after the wait rather than before it, because what the
 * page is loading at the moment it is read is the fact the listing states.
 * @param doc - the frame document about to be read.
 * @param bounds - the quiet window and the total budget.
 * @param isVisible - injected visibility, the reader's own.
 * @returns what the wait found.
 */
export async function settlePage(
  doc: Document,
  bounds: SettleBounds,
  isVisible: (el: Element) => boolean,
): Promise<Settlement> {
  const settled = await whenQuiet(doc, bounds)
  return { settled, busy: busyNames(doc, isVisible) }
}
