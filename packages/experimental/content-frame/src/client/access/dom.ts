/**
 * What the walk knows about a page: HTML and ARIA, and nothing about any
 * particular application. Layout is not one of them — jsdom has none and a
 * frame's layout belongs to the frame — so visibility and geometry arrive as
 * injected functions and only reach the DOM through the caller.
 *
 * `getComputedStyle` and `computeAccessibleName` read through the shell's own
 * window, which reaches elements of every same-origin frame the walk enters.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/dom
 */
import { computeAccessibleName, getRole } from 'dom-accessibility-api'

/** Elements whose content never reaches the reader. */
const SKIP_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript'])

/** Elements that flow inside a line, so text either side of them is one run. */
const INLINE_TAGS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'label',
  'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup',
  'time', 'u', 'var', 'wbr',
])

/** Elements whose `disabled` property the page can set. */
const DISABLEABLE_TAGS: ReadonlySet<string> = new Set(['button', 'fieldset', 'input', 'optgroup', 'option', 'select', 'textarea'])

/** Roles that describe a field the user fills in. */
export const FIELD_ROLES: ReadonlySet<string> =
  new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'listbox', 'checkbox', 'radio', 'switch'])

/** Roles that hold a checked state. */
export const CHECKED_ROLES: ReadonlySet<string> = new Set(['checkbox', 'radio', 'switch'])

/**
 * Roles that describe how the page is built rather than what it offers, so they
 * carry no row of their own. The container roles are here too: an element that
 * fails its container test (a two-item list, an unnamed section) falls through
 * to its contents instead of becoming a row nobody can use. `listbox` is the
 * one container role kept out: a `select` carries it and is a field, not a
 * region, so it has to stay nameable.
 *
 * The live regions are here because they announce what happened elsewhere on
 * the page rather than offering anything of their own; the walk reads straight
 * through them to whatever they show.
 */
const STRUCTURAL_ROLES: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'cell', 'columnheader', 'complementary',
  'contentinfo', 'definition', 'dialog', 'directory', 'document', 'feed', 'figure', 'form', 'generic',
  'grid', 'gridcell', 'group', 'legend', 'list', 'listitem', 'log', 'main', 'marquee', 'math', 'menu',
  'menubar', 'navigation', 'none', 'note', 'paragraph', 'presentation', 'radiogroup', 'region', 'row',
  'rowgroup', 'rowheader', 'search', 'separator', 'status', 'table', 'tablist', 'tabpanel', 'term',
  'timer', 'toolbar', 'tooltip', 'tree', 'treegrid',
])

/** The role a snapshot gives a role-less element the page makes clickable. */
export const CLICKABLE_ROLE = 'clickable'

/** How long one text run may be before it is cut. */
const TEXT_LIMIT = 200

/** How much of an over-long text run survives the cut, before the ellipsis. */
const TEXT_KEPT = 197

/** How much of the smaller rectangle two items must share to count as one. */
const OVERLAP_SHARE = 0.8

/** Text that only separates the items either side of it. */
const SEPARATOR = /^[/>›»|:·•\-–—]+$/

/**
 * Collapse every run of whitespace to one space and trim the ends.
 * @param value - raw text from the page.
 * @returns the collapsed text.
 */
export function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Cut one text run to the length a snapshot prints.
 * @param text - the collapsed text.
 * @returns the text, ending in an ellipsis when it was too long.
 */
export function clip(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_KEPT)}…` : text
}

/**
 * Cut one text run to a length a caller sets, for the places that print less
 * than a whole run: a sample cell, a header cell, the name of a click target.
 * @param text - the collapsed text.
 * @param limit - the longest result, the ellipsis included.
 * @returns the text, ending in an ellipsis when it was too long.
 */
export function clipTo(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * True when the text says nothing but "the next item follows".
 * @param text - one collapsed text run.
 * @returns whether the run is punctuation between items.
 */
export function isSeparator(text: string): boolean {
  return SEPARATOR.test(text)
}

/**
 * True for an element whose text flows into the run around it.
 * @param el - the element to classify.
 * @returns whether text either side of the element is one run.
 */
export function isInline(el: Element): boolean {
  return INLINE_TAGS.has(el.localName)
}

/**
 * The children a walk descends into: an open shadow root replaces the light
 * children it renders in place of.
 * @param el - the element being descended into.
 * @returns the node whose children the walk reads.
 */
export function childHost(el: Element): ParentNode {
  return el.shadowRoot ?? el
}

/**
 * What one selector matches inside a subtree, in document order. Callers read
 * the result as a sequence of the page — the first heading of a section, the
 * strip nearest a table. A browser answers a selector in document order; the
 * sort here makes the reading hold whatever order an engine answers in.
 * @param root - the subtree to search.
 * @param selector - the selector to match.
 * @returns the matching elements, first in the document first.
 */
export function queryInOrder(root: ParentNode, selector: string): Element[] {
  return [...root.querySelectorAll(selector)]
    .sort((a, b) => ((a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) === 0 ? 1 : -1))
}

/**
 * True for a password box, whose value never leaves the page.
 * @param el - the element to classify.
 * @returns whether the element is a password box.
 */
export function isPassword(el: Element): boolean {
  return el.localName === 'input' && el.getAttribute('type')?.toLowerCase() === 'password'
}

/**
 * The element's role. A password box has none of its own, and the model still
 * needs to see the field, so it reads as the text box it is.
 * @param el - the element to classify.
 * @returns the role name, or null for an element HTML gives no role.
 */
export function roleOf(el: Element): string | null {
  return isPassword(el) ? 'textbox' : getRole(el)
}

/**
 * True for a role that names something the model can read or act on, rather
 * than how the page is assembled.
 * @param role - the element's role.
 * @returns whether the role earns a row of its own.
 */
export function isNameable(role: string): boolean {
  return !STRUCTURAL_ROLES.has(role)
}

/**
 * The element's accessible name.
 * @param el - the element to name.
 * @returns the collapsed name, empty when the element has none.
 */
export function nameOf(el: Element): string {
  return clip(collapse(computeAccessibleName(el)))
}

/**
 * The first heading inside an element, in document order, for a region whose
 * title is written rather than labelled.
 * @param el - the element to look inside.
 * @param isVisible - injected visibility.
 * @returns the heading's text, empty when there is none.
 */
export function headingText(el: Element, isVisible: (el: Element) => boolean): string {
  for (const heading of queryInOrder(el, 'h1, h2, h3, h4, h5, h6, [role="heading"]')) {
    if (!isSkipped(heading, isVisible)) return clip(visibleText(heading, isVisible))
  }
  return ''
}

/**
 * A container's name: what it is labelled, or failing that what it is titled.
 * @param el - the container element.
 * @param isVisible - injected visibility.
 * @returns the name, empty when the container has none.
 */
export function containerName(el: Element, isVisible: (el: Element) => boolean): string {
  const name = nameOf(el)
  return name === '' ? headingText(el, isVisible) : name
}

/**
 * The selector matching every element that could carry one of the markers
 * pages name a widget by convention with — a breadcrumb trail, a pagination
 * strip. A search reads these candidates rather than every element of the
 * page, and confirms each one with `isMarked`.
 * @param marker - the lower-case word the convention uses.
 * @returns the selector.
 */
export function markedSelector(marker: string): string {
  return `[class*="${marker}" i], [aria-label*="${marker}" i]`
}

/**
 * True when an element carrying the marker means it, which for a class name it
 * always does and for a label only a navigation region does. The role is
 * computed last: it is the expensive half of the test and the class names
 * settle most candidates without it.
 * @param el - a candidate that matched {@link markedSelector} for this marker.
 * @param marker - the lower-case word the convention uses.
 * @returns whether the element is the widget the marker names.
 */
export function isMarked(el: Element, marker: string): boolean {
  const className = el.getAttribute('class')
  if (className !== null && className.toLowerCase().includes(marker)) return true
  return roleOf(el) === 'navigation'
}

/**
 * True for an element that carries no content of its own, as opposed to one
 * the page merely hides: what is inside it is source, not page.
 * @param el - the element to classify.
 * @returns whether the element's subtree is not content.
 */
export function isNonContent(el: Element): boolean {
  return SKIP_TAGS.has(el.localName)
}

/**
 * True for an element the reader never sees, along with everything inside it.
 * @param el - the element to classify.
 * @param isVisible - injected visibility.
 * @returns whether the walk skips the element and its subtree.
 */
export function isSkipped(el: Element, isVisible: (el: Element) => boolean): boolean {
  return isNonContent(el)
    || el.getAttribute('aria-hidden') === 'true'
    || el.hasAttribute('hidden')
    || !isVisible(el)
}

/**
 * Every run of visible text inside an element, in document order.
 * @param el - the element to read.
 * @param isVisible - injected visibility.
 * @param stopAt - subtrees whose text belongs to something else, left out along
 * with everything inside them; every subtree is read when it is omitted.
 * @returns the collapsed, non-empty runs.
 */
export function visibleTextParts(
  el: Element,
  isVisible: (el: Element) => boolean,
  stopAt?: (child: Element) => boolean,
): string[] {
  const parts: string[] = []
  for (const node of childHost(el).childNodes) {
    if (node.nodeType === node.TEXT_NODE) {
      const text = collapse((node as Text).data)
      if (text !== '') parts.push(text)
    } else if (node.nodeType === node.ELEMENT_NODE) {
      const child = node as Element
      if (!isSkipped(child, isVisible) && stopAt?.(child) !== true) {
        parts.push(...visibleTextParts(child, isVisible, stopAt))
      }
    }
  }
  return parts
}

/**
 * The visible text of an element as one run.
 * @param el - the element to read.
 * @param isVisible - injected visibility.
 * @param stopAt - subtrees whose text belongs to something else.
 * @returns the collapsed text, empty when the element shows none.
 */
export function visibleText(
  el: Element,
  isVisible: (el: Element) => boolean,
  stopAt?: (child: Element) => boolean,
): string {
  return visibleTextParts(el, isVisible, stopAt).join(' ')
}

/**
 * The value a field currently holds.
 * @param el - the field element.
 * @returns the value, or undefined for an element that holds none.
 */
export function fieldValue(el: Element): string | undefined {
  const tag = el.localName
  if (tag === 'select') {
    const selected = (el as HTMLSelectElement).selectedOptions[0]
    return selected === undefined ? '' : clip(collapse(selected.text))
  }
  if (tag === 'input' || tag === 'textarea') return clip(collapse((el as HTMLInputElement | HTMLTextAreaElement).value))
  return undefined
}

/**
 * Whether a checkbox, radio, or switch is currently on.
 * @param el - the element to read.
 * @returns its checked state.
 */
export function isChecked(el: Element): boolean {
  const aria = el.getAttribute('aria-checked')
  if (aria !== null) return aria === 'true'
  return el.localName === 'input' && (el as HTMLInputElement).checked
}

/**
 * Whether the page has disabled the element.
 * @param el - the element to read.
 * @returns its disabled state.
 */
export function isDisabled(el: Element): boolean {
  if (el.getAttribute('aria-disabled') === 'true') return true
  return DISABLEABLE_TAGS.has(el.localName) && (el as HTMLInputElement).disabled
}

/**
 * The default clickability test: a page that gives a role-less element a
 * pointer cursor is telling the reader it can be clicked.
 * @param el - the element to classify.
 * @returns whether the element looks clickable.
 */
export function looksClickable(el: Element): boolean {
  return getComputedStyle(el).cursor === 'pointer'
}

/**
 * The document inside a frame, when this page may read it.
 * @param frame - the frame element.
 * @returns the frame's document, or undefined for a frame of another origin.
 */
export function frameDocument(frame: Element): Document | undefined {
  try {
    return (frame as HTMLIFrameElement).contentDocument ?? undefined
  } catch {
    // Reading a cross-origin frame's document throws in some engines and
    // answers null in others; both mean the same thing to the reader.
    return undefined
  }
}

/**
 * Every document this page may read, the root first and each same-origin frame
 * after it.
 * @param root - the root document.
 * @returns the readable documents, in document order.
 */
export function readableDocuments(root: Document): Document[] {
  const documents = [root]
  for (const doc of documents) {
    for (const frame of doc.querySelectorAll('iframe')) {
      const inner = frameDocument(frame)
      if (inner !== undefined) documents.push(inner)
    }
  }
  return documents
}

/**
 * True when two rectangles cover so much of the same ground that they are one
 * thing drawn twice, the way a pinned table column repeats its cells.
 * @param a - the first rectangle.
 * @param b - the second rectangle.
 * @returns whether they overlap by most of the smaller one.
 */
export function rectsOverlap(a: DOMRectReadOnly, b: DOMRectReadOnly): boolean {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  const shared = Math.max(0, width) * Math.max(0, height)
  const smaller = Math.min(a.width * a.height, b.width * b.height)
  return smaller > 0 && shared >= smaller * OVERLAP_SHARE
}
