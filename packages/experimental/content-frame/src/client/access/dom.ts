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

/**
 * Elements that flow inside a line, so text either side of them is one run. A
 * line break and a picture sit inside a paragraph rather than ending it: the
 * words either side of them are still one thing to read, and `picture` is here
 * because it is the wrapping a page puts around an `img` rather than a block of
 * its own. A drawing flows the same way, and is left out of this set because
 * the walk stops at one rather than classifying it — see {@link isOpaque}.
 */
const INLINE_TAGS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'img', 'kbd',
  'label', 'mark', 'picture', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong',
  'sub', 'sup', 'time', 'u', 'var', 'wbr',
])

/** Elements whose `disabled` property the page can set. */
const DISABLEABLE_TAGS: ReadonlySet<string> = new Set(['button', 'fieldset', 'input', 'optgroup', 'option', 'select', 'textarea'])

/** Roles that describe a field the user fills in. */
export const FIELD_ROLES: ReadonlySet<string> =
  new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'listbox', 'checkbox', 'radio', 'switch'])

/**
 * Roles that hold a checked state. A menu item that checks or picks is one of
 * these: a reader who cannot see whether it is on clicks it again and turns it
 * off.
 */
export const CHECKED_ROLES: ReadonlySet<string> =
  new Set(['checkbox', 'menuitemcheckbox', 'menuitemradio', 'radio', 'switch'])

/** Roles that report a quantity the page sets, rather than one the user fills in. */
export const QUANTITY_ROLES: ReadonlySet<string> = new Set(['progressbar', 'meter'])

/**
 * The roles WAI-ARIA 1.2 §5.2.8.5 names from the text the element holds. A row
 * whose name was computed for a role the walk did not read is named from the
 * page instead, and only for these: a role named some other way says nothing
 * about the text under it.
 *
 * The list follows the specification's own table, the abstract role it names
 * included, so a later ARIA version means adding the roles it defines here.
 */
export const NAME_FROM_CONTENT_ROLES: ReadonlySet<string> = new Set([
  'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'sectionhead',
  'switch', 'tab', 'tooltip', 'treeitem',
])

/**
 * Every role WAI-ARIA 1.2 defines for authors, plus the three the graphics
 * module adds. A role the page wrote that is not one of these names nothing the
 * reader knows, so the element is read by what it is built out of instead: a
 * page's own word must never reach the model as the type of a row.
 *
 * The list follows the specification's own, so a later ARIA version means
 * adding the roles it defines here and deciding for each of them, in the same
 * change, whether it belongs in {@link STRUCTURAL_ROLES}.
 */
const KNOWN_ROLES: ReadonlySet<string> = new Set([
  // Widget roles.
  'button', 'checkbox', 'gridcell', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'progressbar', 'radio', 'scrollbar', 'searchbox', 'separator', 'slider', 'spinbutton',
  'switch', 'tab', 'tabpanel', 'textbox', 'treeitem',
  // Composite widget roles.
  'combobox', 'grid', 'listbox', 'menu', 'menubar', 'radiogroup', 'tablist', 'tree', 'treegrid',
  // Document structure roles.
  'application', 'article', 'blockquote', 'caption', 'cell', 'code', 'columnheader', 'definition',
  'deletion', 'directory', 'document', 'emphasis', 'feed', 'figure', 'generic', 'group', 'heading',
  'img', 'insertion', 'list', 'listitem', 'math', 'meter', 'none', 'note', 'paragraph',
  'presentation', 'row', 'rowgroup', 'rowheader', 'strong', 'subscript', 'superscript', 'table',
  'term', 'time', 'toolbar', 'tooltip',
  // Landmark roles.
  'banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search',
  // Live region roles.
  'alert', 'log', 'marquee', 'status', 'timer',
  // Window roles.
  'alertdialog', 'dialog',
  // Graphics module roles.
  'graphics-document', 'graphics-object', 'graphics-symbol',
])

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
 * through them to whatever they show. The roles that mark up a run of text —
 * an emphasis, a quotation, a time — are here for the same reason: what they
 * decorate is the text itself, which the run around them already prints. So are
 * the two that report a quantity: a meter and a progress bar say what they hold
 * in the text they draw, and one that draws none has nothing to report.
 */
const STRUCTURAL_ROLES: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'caption', 'cell', 'code',
  'columnheader', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory',
  'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group',
  'insertion', 'legend', 'list', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar',
  'meter', 'navigation', 'none', 'note', 'paragraph', 'presentation', 'progressbar', 'radiogroup',
  'region', 'row', 'rowgroup', 'rowheader', 'search', 'separator', 'status', 'strong', 'subscript',
  'superscript', 'table', 'tablist', 'tabpanel', 'term', 'time', 'timer', 'toolbar', 'tooltip',
  'tree', 'treegrid',
])

/** The role a snapshot gives a role-less element the page makes clickable. */
export const CLICKABLE_ROLE = 'clickable'

/**
 * The roles HTML itself gives an element that `dom-accessibility-api` does not
 * map. HTML-AAM gives `meter` the role of the same name; the library answers
 * nothing for that tag, and a bar the page named would reach the reader as
 * nothing at all. A tag leaves this map when the library maps it.
 */
const TAG_ROLES: ReadonlyMap<string, string> = new Map([['meter', 'meter']])

/** Every element the page shows as a dialog, an alert included. */
export const DIALOG_SELECTOR = 'dialog, [role~="dialog"], [role~="alertdialog"]'

/**
 * Elements a browser draws itself rather than laying out what is written inside
 * them: a picture built out of shapes, a media element, a bar reporting a
 * quantity, and the markup kept for a reader running no script. What they hold
 * is a part of the drawing or a fallback no engine in use renders, so the walk
 * neither descends into one, reads its text, nor counts a row inside it.
 */
const OPAQUE_SELECTOR = 'svg, canvas, video, audio, object, progress, meter, noscript'

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
 *
 * A role the page wrote is only a role when ARIA defines it: a misspelled or
 * framework-private word tells the reader nothing, and printing it would put
 * text the page controls where the model reads the kind of a row. Such an
 * element reads by its structure instead. What HTML itself gives an element is
 * not filtered — that role comes from the tag, not from the page.
 *
 * A page may write several roles and mean the first one a reader understands,
 * which is how a document written against a newer vocabulary falls back to an
 * older one, so the tokens are read in order and the first defined role wins.
 * The comparison is case-sensitive, as ARIA defines these names. Every selector
 * this package matches a role with reads the attribute the same way — one
 * token of several, `[role~="x"]` — so a page that falls back is answered the
 * same wherever it is asked about.
 *
 * A page that marks an element as decoration and still labels it, or draws it
 * with something the user can operate, has written two things that contradict
 * each other; ARIA resolves that in favour of what the element offers, and the
 * library implements the resolution for the role it reads.
 * @param el - the element to classify.
 * @returns the role name, or null for an element with no role ARIA knows.
 */
export function roleOf(el: Element): string | null {
  if (isPassword(el)) return 'textbox'
  // An empty role attribute declares nothing, and leaves the tag's own role.
  const declared = el.getAttribute('role')?.trim() ?? ''
  if (declared === '' || libraryRole(el) === 'presentation') return tagRole(el)
  return declared.split(/\s+/).find(token => KNOWN_ROLES.has(token)) ?? null
}

/**
 * The role HTML gives an element, which is the role of anything the page has
 * not given one.
 * @param el - the element to classify.
 * @returns the role name, or null for a tag HTML gives no role.
 */
function tagRole(el: Element): string | null {
  return getRole(el) ?? TAG_ROLES.get(el.localName) ?? null
}

/**
 * The role `dom-accessibility-api` reads: the first word of the attribute
 * alone, cut on spaces. The name it computes and the presentational conflict it
 * resolves are answers about that role, so a walk that read another one cannot
 * take those answers unchanged.
 * @param el - the element to read.
 * @returns the word the library takes as the role, empty when the page wrote none.
 */
export function libraryRole(el: Element): string {
  const declared = el.getAttribute('role')?.trim() ?? ''
  const cut = declared.indexOf(' ')
  return cut === -1 ? declared : declared.slice(0, cut)
}

/**
 * True for an element whose content a browser never renders: a drawing, a media
 * element, a bar, the markup kept for a reader running no script. A path is not
 * a paragraph, the title a drawing carries is a tooltip the page never shows,
 * and the words inside a `progress` are there for an engine that cannot draw
 * one.
 * @param el - the element to classify.
 * @returns whether the walk stops at the element rather than reading into it.
 */
export function isOpaque(el: Element): boolean {
  return el.matches(OPAQUE_SELECTOR)
}

/**
 * True for an element written inside one of those, which is no row of the page
 * however it is marked up: a link drawn as a slice of a chart is a part of the
 * picture, and a button offered to a reader with no script is offered to nobody.
 * @param el - the element to classify.
 * @returns whether something the page never renders encloses the element.
 */
export function insideOpaque(el: Element): boolean {
  const holder = el.closest(OPAQUE_SELECTOR)
  return holder !== null && holder !== el
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
  for (const heading of queryInOrder(el, 'h1, h2, h3, h4, h5, h6, [role~="heading"]')) {
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
 * Every run of visible text inside an element, in document order. What the page
 * never renders is not looked into: the words in a drawing label the picture,
 * and the words in a media element are for a reader who cannot see it.
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
      if (!isSkipped(child, isVisible) && !isOpaque(child) && stopAt?.(child) !== true) {
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
 * What a bar reports: the text the page wrote for it, the number behind that
 * text, or the value a native bar carries. A bar carrying none of the three
 * draws whatever it means somewhere else, and reports nothing here.
 * @param el - the bar element.
 * @returns the value, or undefined for a bar that reports none.
 */
export function quantityValue(el: Element): string | undefined {
  const declared = el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow')
  if (declared !== null) return clip(collapse(declared))
  const tag = el.localName
  if (tag !== 'progress' && tag !== 'meter') return undefined
  const value = el.getAttribute('value')
  return value === null ? undefined : clip(collapse(value))
}

/**
 * Whether a checkbox, radio, or switch is currently on. A box the browser keeps
 * the state of is read from the browser; anything else the page draws as one
 * has the state it wrote, and no state at all until it writes one. ARIA
 * requires the attribute on these roles, so a page that leaves it out has not
 * said the control is off — it has said nothing, and a reader told "off" would
 * click to turn on what is already on.
 *
 * A box the page reports as half checked has no state of the two either: it is
 * the box at the head of a table with some of its rows picked, and a reader
 * told it is off clicks it and picks every row on the page.
 * @param el - the element to read.
 * @returns its checked state, or undefined when the page has declared none.
 */
export function isChecked(el: Element): boolean | undefined {
  if (el.localName === 'input') return (el as HTMLInputElement).checked
  const aria = el.getAttribute('aria-checked')
  if (aria === 'true') return true
  return aria === 'false' ? false : undefined
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
