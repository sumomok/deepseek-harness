/**
 * The page as it was written, for the three reads that print it: one subtree's
 * markup as an indented tree, one element's attributes, and one element's whole
 * text.
 *
 * Nothing here reads meaning out of a page. A tag, an id, a class token and an
 * attribute value are printed as the document spells them, in the order the
 * document holds them, and what any of it means is for a skill about that
 * application to say. That is the division this module exists for: `snapshot.ts`
 * answers what HTML and ARIA say the page is, and this answers what it is
 * written as.
 *
 * Two rules bound it. What a browser never renders as page — a script, a style
 * sheet, a template — is not markup of the page and is left out with everything
 * inside it. And what a password control holds is printed by none of the three:
 * the attribute read withholds the `value` that could carry one, and the tree
 * and whole-text reads withhold the text a `textarea` keeps one in.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/markup
 */
import {
  CONTENT_READ_ATTRS_TOOL_NAME, CONTENT_READ_DOM_TOOL_NAME,
} from '../../access/wire.ts'
import { MORE_TEXT_MARKER, NO_ATTRIBUTES_LINE, NO_TEXT_LINE, WITHHELD } from '../../access/text.ts'
import type { ContentMarkupRequest } from '../../types.ts'
import { childHost, clipTo, collapse, isInline, isNonContent, isOpaque, isPassword, isSkipped } from './dom.ts'
import { entry, indent, printedMark, resume, type Entry, type Listing } from './render.ts'
import { pageHeader, readOf, resolveRef } from './snapshot.ts'
import type { Snapshot, SnapshotOptions } from './model.ts'
import type { RefTable } from './refs.ts'

/**
 * How much of one element's own text a tree line prints before it is cut.
 *
 * A tree line exists to say which element this is, and the first words an
 * element holds are what say it; a line that printed only part of them says so.
 * Shorter than the listing's own 200-character run because a tree prints a line
 * per element rather than per item, so a subtree of fifty elements would spend
 * its whole budget on text nobody asked for.
 */
const LINE_TEXT_LIMIT = 80

/** The one attribute a password control never answers with. */
const SECRET_ATTRIBUTE = 'value'

/**
 * The text one element holds directly, its descendants' text left to their own
 * lines.
 *
 * Direct rather than whole, because a tree prints a line per element: text read
 * through the descendants would print once for every ancestor over it, and a
 * page's outermost element would carry the whole page on one line.
 * @param el - the element to read.
 * @returns the raw text of its own text nodes, in order.
 */
function directText(el: Element): string {
  let text = ''
  for (const node of childHost(el).childNodes) {
    if (node.nodeType === node.TEXT_NODE) text += (node as Text).data
  }
  return text
}

/**
 * One element as a tree line prints it: its ref, its tag, its id, its class
 * tokens, and the start of the text it holds.
 *
 * The class tokens are printed by the same {@link printedMark} the listing
 * prints them with, so a step naming a row this tree printed carries the string
 * this tree showed and the seat compares the two character for character.
 *
 * What a password control holds is answered with {@link WITHHELD} in place of
 * that text: a `textarea` declaring a password in `autocomplete` keeps its
 * value in a text node, which is the one place a tree line would print one.
 * @param el - the element the line names.
 * @param depth - how many elements of the subtree enclose it.
 * @param refs - the page's numbering.
 * @returns the rendered line.
 */
function treeLine(el: Element, depth: number, refs: RefTable): string {
  const ref = refs.ref(el)
  const id = el.id === '' ? '' : `#${el.id}`
  const head = `${indent(depth)}${ref} ${el.localName}${id}${printedMark(el)}`
  if (isPassword(el)) return `${head} ${WITHHELD}`
  const own = collapse(directText(el))
  const cut = own.length > LINE_TEXT_LIMIT
  return `${head}${own === '' ? '' : ` "${clipTo(own, LINE_TEXT_LIMIT)}"`}${cut ? MORE_TEXT_MARKER : ''}`
}

/**
 * One row per element of the subtree, the scope element first and each
 * descendant indented under it.
 *
 * An open shadow root replaces the light children it renders in place of, the
 * way every other walk in this package reads them. What a browser never renders
 * as page is left out with its subtree; everything else is printed, hidden
 * elements included — a row the listing dropped for being invisible is exactly
 * what a reader comes here for.
 * @param root - the element the read asked for.
 * @param refs - the page's numbering.
 * @returns the rows, in document order.
 */
function treeEntries(root: Element, refs: RefTable): Entry[] {
  const rows: Entry[] = []
  const walk = (el: Element, depth: number): void => {
    rows.push(entry(el, refs, () => treeLine(el, depth, refs)))
    for (const child of childHost(el).children) {
      if (!isNonContent(child)) walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

/**
 * One element's attributes, name and value as the page wrote them.
 *
 * The value is quoted the way JSON quotes a string, so an attribute holding a
 * quote, a backslash or a line break is still one line and still says exactly
 * what the page wrote. Nothing is cut and nothing is ordered: the attributes
 * arrive in the order the element holds them.
 * @param el - the element to read.
 * @param refs - the page's numbering.
 * @returns the rendered answer.
 */
function attributeLines(el: Element, refs: RefTable): Listing {
  const secret = isPassword(el)
  const lines = [...el.attributes].map(attribute => (
    secret && attribute.name === SECRET_ATTRIBUTE
      ? `${indent(1)}${attribute.name}=${WITHHELD}`
      : `${indent(1)}${attribute.name}=${JSON.stringify(attribute.value)}`
  ))
  const head = `${refs.ref(el)} ${el.localName}`
  return {
    kind: 'attrs',
    text: [head, ...lines.length === 0 ? [`${indent(1)}${NO_ATTRIBUTES_LINE}`] : lines].join('\n'),
    truncated: false,
    shown: lines.length,
    total: lines.length,
    cursor: undefined,
  }
}

/**
 * True for an element whose text a whole-text read never prints: what the page
 * hides is not text the user reads, what a browser draws itself holds a
 * fallback rather than a run of the page, and what a password control holds is
 * a credential.
 * @param el - the element to classify.
 * @param isVisible - injected visibility.
 * @returns whether the read passes over the element and its subtree.
 */
function isWithheld(el: Element, isVisible: (child: Element) => boolean): boolean {
  return isSkipped(el, isVisible) || isOpaque(el) || isPassword(el)
}

/**
 * Every line of visible text one element shows, as the page breaks them.
 *
 * `innerText` is what this stands in for and cannot be used: the seat reads
 * documents a DOM implementation without layout also has to answer for. So the
 * break is taken from what the element is rather than from where it was laid
 * out — a run inside an inline element continues the line, and anything else
 * starts one — which is the rule a page's own markup states and the one a
 * browser follows for everything a page does not restyle.
 *
 * The element the read named is held to the same three rules its descendants
 * are, so what a whole-text read prints of a subtree and what it prints when
 * asked for one element of it say the same thing.
 * @param el - the element to read.
 * @param isVisible - injected visibility.
 * @returns the collapsed, non-empty lines, in document order.
 */
function textLines(el: Element, isVisible: (child: Element) => boolean): string[] {
  if (isWithheld(el, isVisible)) return []
  const lines: string[] = []
  let run = ''
  const flush = (): void => {
    const text = collapse(run)
    if (text !== '') lines.push(text)
    run = ''
  }
  const walk = (node: Element): void => {
    for (const child of childHost(node).childNodes) {
      if (child.nodeType === child.TEXT_NODE) {
        run += (child as Text).data
        continue
      }
      if (child.nodeType !== child.ELEMENT_NODE) continue
      const element = child as Element
      if (isWithheld(element, isVisible)) continue
      if (element.localName === 'br') {
        flush()
        continue
      }
      if (isInline(element)) {
        walk(element)
        continue
      }
      flush()
      walk(element)
      flush()
    }
  }
  walk(el)
  flush()
  return lines
}

/**
 * One element's whole text.
 * @param el - the element to read.
 * @param isVisible - injected visibility.
 * @returns the rendered answer, never cut.
 */
function wholeText(el: Element, isVisible: (child: Element) => boolean): Listing {
  const lines = textLines(el, isVisible)
  const empty = isPassword(el) ? WITHHELD : NO_TEXT_LINE
  return {
    kind: 'content',
    text: lines.length === 0 ? empty : lines.join('\n'),
    truncated: false,
    shown: lines.length,
    total: lines.length,
    cursor: undefined,
  }
}

/**
 * Read the page as it was written, for whichever of the three reads asked.
 * @param root - the document the user is looking at.
 * @param request - the pending call: which read, and the ref it named.
 * @param options - the read's budget, numbering and injected visibility.
 * @returns the read the seat posts.
 * @throws {Error} when `scope`, `after` or `ref` names an element the page no
 * longer has, or when `after` names no element of this tree.
 */
export function markup(root: Document, request: ContentMarkupRequest, options: SnapshotOptions): Snapshot {
  options.refs.sweep()
  const header = pageHeader(root, options.isVisible)
  if (request.tool === CONTENT_READ_DOM_TOOL_NAME) {
    const { after, scope } = request.args
    const top = resolveRef('scope', scope, options.refs)
    if (after !== undefined) resolveRef('after', after, options.refs)
    // The cursor is read off the call rather than off the seat's options: one
    // home for what this read was asked, and the listing's own `after` means a
    // row of the listing, which is a different set of rows.
    const resumed = { ...options, ...after === undefined ? {} : { after } }
    return readOf(header, resume('dom', treeEntries(top, options.refs), resumed))
  }
  const el = resolveRef('ref', request.args.ref, options.refs)
  return readOf(header, request.tool === CONTENT_READ_ATTRS_TOOL_NAME
    ? attributeLines(el, options.refs)
    : wholeText(el, options.isVisible))
}
