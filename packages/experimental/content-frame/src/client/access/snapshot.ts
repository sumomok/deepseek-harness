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
 *
 * It also holds the three things every read of the page shares, markup reads
 * included: what the page is above whatever is printed of it, the lookup that
 * turns a ref into an element, and the assembly of the two into one answer.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/snapshot
 */
import { DIALOG_SELECTOR, containerName, isSkipped, queryInOrder, readableDocuments } from './dom.ts'
import { collect } from './collect.ts'
import { render, type Listing } from './render.ts'
import type { RefTable } from './refs.ts'
import type { Snapshot, SnapshotHeader, SnapshotOptions } from './model.ts'

export type { ContainerType, Snapshot, SnapshotHeader, SnapshotMode, SnapshotOptions } from './model.ts'

/**
 * The element one ref names, or a refusal the model can act on. Shared by every
 * read that takes a ref, so a stale one is answered the same sentence whichever
 * tool asked.
 * @param option - the option that carried the ref, named as the model wrote it.
 * @param ref - the ref to resolve.
 * @param refs - the page's numbering.
 * @returns the element.
 * @throws {Error} when the ref names nothing on the page any more.
 */
export function resolveRef(option: string, ref: string, refs: RefTable): Element {
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
 * What the page is, read across every frame it is built from rather than from
 * the root document alone: an application hosted in a frame keeps its title bar
 * and its dialogs inside that frame.
 *
 * Every read of the page takes it, the markup reads included, so what a read
 * says the page is does not depend on which of the four asked.
 * @param root - the root document.
 * @param isVisible - injected visibility.
 * @returns the header.
 */
export function pageHeader(root: Document, isVisible: (el: Element) => boolean): SnapshotHeader {
  const documents = readableDocuments(root)
  const modal = openDialogName(documents, isVisible)
  return {
    url: root.URL,
    title: root.title,
    ...(modal === undefined ? {} : { modal }),
  }
}

/**
 * One read, from what it found above the page and what it printed of it.
 * @param header - what the page is.
 * @param listing - the rendered answer.
 * @returns the read the seat posts.
 */
export function readOf(header: SnapshotHeader, listing: Listing): Snapshot {
  return {
    kind: listing.kind,
    header,
    text: listing.text,
    truncated: listing.truncated,
    shown: listing.shown,
    total: listing.total,
    ...(listing.cursor === undefined ? {} : { cursor: listing.cursor }),
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
  const scope = options.scope === undefined ? undefined : resolveRef('scope', options.scope, options.refs)
  if (options.after !== undefined) resolveRef('after', options.after, options.refs)
  return readOf(pageHeader(root, options.isVisible), render(collect(root, options, scope), options, scope))
}
