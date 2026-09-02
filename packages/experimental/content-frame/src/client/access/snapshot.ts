/**
 * The structural read of a page: what the model gets instead of a screenshot.
 * One call walks the document the user is looking at — through open shadow
 * roots and same-origin frames — and answers with numbered rows the model can
 * point back at, under a character budget.
 *
 * What the read is for decides what it leaves out. Structure reaches the model;
 * data does not. A table reports its header, its size, and one sample row,
 * never its contents, and rows arrive only when a read asks for that table by
 * ref or searches for one by its text. A password box reports that it is there
 * and never what it holds.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/snapshot
 */
import {
  DIALOG_SELECTOR, clip, containerName, isMarked, isSeparator, isSkipped, markedSelector, queryInOrder,
  readableDocuments, visibleTextParts,
} from './dom.ts'
import { collect } from './collect.ts'
import { render } from './render.ts'
import type { RefTable } from './refs.ts'
import type { Snapshot, SnapshotHeader, SnapshotOptions } from './model.ts'

export type { ContainerType, Snapshot, SnapshotHeader, SnapshotMode, SnapshotOptions } from './model.ts'

/** What joins two steps of a breadcrumb trail. */
const BREADCRUMB_SEPARATOR = ' › '

/** The word pages use to mark the trail showing where the user is. */
const BREADCRUMB_MARKER = 'breadcrumb'

/** The fields whose visible pairing means the page is asking the user to sign in. */
const SIGN_IN_PARTNER = 'input[type="text"], input[type="email"], input:not([type])'

/**
 * How far around a password box the search for the box naming the account
 * reaches when no form encloses it: a password box in one part of the page and
 * a search box in another are not a sign-in form.
 */
const SIGN_IN_SCOPE = [
  'form', '[role~="form"]', 'dialog', '[role~="dialog"]', 'main', '[role~="main"]',
  'section', '[role~="region"]', '[role~="tabpanel"]',
].join(', ')

/**
 * The element one ref names, or a refusal the model can act on.
 * @param option - the option that carried the ref, named as the model wrote it.
 * @param ref - the ref to resolve.
 * @param refs - the page's numbering.
 * @returns the element.
 * @throws {Error} when the ref names nothing on the page any more.
 */
function resolveOrThrow(option: string, ref: string, refs: RefTable): Element {
  const el = refs.resolve(ref)
  if (el === undefined) throw new Error(`${option}: "${ref}" names no element on the page now`)
  return el
}

/**
 * The dialog the page currently has open, preferring one that declares itself
 * modal over one that merely sits on top. Failing a modal, the first open
 * dialog in document order is the one reported. An alert dialog is one of
 * these: what it asks for stands in front of the page like any other.
 * @param documents - every readable document.
 * @param isVisible - injected visibility.
 * @returns the dialog's name, or undefined when none is open.
 */
function openDialogName(documents: readonly Document[], isVisible: (el: Element) => boolean): string | undefined {
  let topmost: string | undefined
  for (const doc of documents) {
    for (const el of queryInOrder(doc, DIALOG_SELECTOR)) {
      if (isSkipped(el, isVisible)) continue
      const name = containerName(el, isVisible)
      if (el.getAttribute('aria-modal') === 'true') return name
      topmost ??= name
    }
  }
  return topmost
}

/**
 * The trail saying where in the application the user currently is.
 * @param documents - every readable document.
 * @param isVisible - injected visibility.
 * @returns the trail, or undefined when the page shows none.
 */
function breadcrumbTrail(documents: readonly Document[], isVisible: (el: Element) => boolean): string | undefined {
  for (const doc of documents) {
    for (const el of queryInOrder(doc, markedSelector(BREADCRUMB_MARKER))) {
      if (!isMarked(el, BREADCRUMB_MARKER) || isSkipped(el, isVisible)) continue
      // The punctuation between steps is the trail's own drawing, not a step.
      const steps = visibleTextParts(el, isVisible).filter(part => !isSeparator(part))
      if (steps.length > 0) return clip(steps.join(BREADCRUMB_SEPARATOR))
    }
  }
  return undefined
}

/**
 * True when the page is asking the user to sign in: a visible password box
 * with a visible box to name the account beside it. Beside means inside the
 * same form, or failing that the same region of the page; a page with no
 * regions at all is searched whole, because then there is nowhere else the two
 * could be.
 * @param documents - every readable document.
 * @param isVisible - injected visibility.
 * @returns whether the page is a sign-in page.
 */
function asksToSignIn(documents: readonly Document[], isVisible: (el: Element) => boolean): boolean {
  for (const doc of documents) {
    for (const secret of doc.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
      if (isSkipped(secret, isVisible)) continue
      const form: ParentNode = secret.form ?? secret.closest(SIGN_IN_SCOPE) ?? doc
      for (const partner of form.querySelectorAll(SIGN_IN_PARTNER)) {
        if (!isSkipped(partner, isVisible)) return true
      }
    }
  }
  return false
}

/**
 * What the page is, read across every frame it is built from rather than from
 * the root document alone: an application hosted in a frame keeps its title
 * bar, its trail, and its dialogs inside that frame.
 * @param root - the root document.
 * @param options - the read's options.
 * @returns the header.
 */
function readHeader(root: Document, options: SnapshotOptions): SnapshotHeader {
  const documents = readableDocuments(root)
  const breadcrumb = breadcrumbTrail(documents, options.isVisible)
  const modal = openDialogName(documents, options.isVisible)
  return {
    url: root.URL,
    title: root.title,
    ...(breadcrumb === undefined ? {} : { breadcrumb }),
    ...(modal === undefined ? {} : { modal }),
    signIn: asksToSignIn(documents, options.isVisible),
  }
}

/**
 * Read one page.
 * @param root - the document the user is looking at.
 * @param options - what to read and how much of it.
 * @returns the structural read.
 * @throws {Error} when `scope` or `after` names an element the page no longer
 * has, when `after` names an element that is not a row of this read's listing,
 * or when `find` is combined with `mode: 'map'`.
 */
export function snapshot(root: Document, options: SnapshotOptions): Snapshot {
  options.refs.sweep()
  const scope = options.scope === undefined ? undefined : resolveOrThrow('scope', options.scope, options.refs)
  if (options.after !== undefined) resolveOrThrow('after', options.after, options.refs)
  const listing = render(collect(root, options, scope), options, scope)
  return {
    kind: listing.kind,
    header: readHeader(root, options),
    text: listing.text,
    truncated: listing.truncated,
    shown: listing.shown,
    total: listing.total,
    ...(listing.cursor === undefined ? {} : { cursor: listing.cursor }),
  }
}
