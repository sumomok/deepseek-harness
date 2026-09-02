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
 * Eleven of the members never reach the fallback that consults this list. Six —
 * `cell`, `columnheader`, `gridcell`, `row`, `rowheader`, and `tooltip` — reach
 * the walk through the table and the structure it reads; four — `treeitem`,
 * `menuitem`, `menuitemcheckbox`, and `menuitemradio` — are the node roles,
 * named by the ladder a node is named on before this list is consulted; and
 * `sectionhead` is abstract and reaches nothing. What a page writes those on is
 * read as a table, read as a node, or read through, and never named from its
 * contents here.
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

/** The two spellings ARIA gives the role that marks an element as decoration. */
const DECORATIVE_ROLES: ReadonlySet<string> = new Set(['presentation', 'none'])

/**
 * Every element a reader can put the focus on, which is the first half of the
 * conflict ARIA resolves against a decoration role. `tabindex` is matched
 * however the page set it: an element the page took out of the tab order still
 * takes the focus from a click. A media element with controls is focusable too
 * and is left out because adding it would change nothing: the conflict is
 * resolved to the role HTML gives the tag, and HTML gives `video` and `audio`
 * none. Neither tag is one that earns a row by itself, so a media element the
 * page marks as decoration prints nothing however the two are spelled.
 */
const FOCUSABLE_SELECTOR = [
  '[tabindex]', 'button', 'select', 'textarea', 'summary', 'a[href]', 'area[href]',
  'input:not([type="hidden"])', '[contenteditable]:not([contenteditable="false"])',
].join(', ')

/**
 * The states and properties WAI-ARIA 1.2 §6.6 defines on every role, which is
 * the list that section names in full. A page writes one of these on an element
 * it also marked as decoration only where it means the element to reach the
 * reader, which is the second half of the conflict ARIA resolves.
 */
const GLOBAL_ARIA_SELECTOR = [
  '[aria-atomic]', '[aria-busy]', '[aria-controls]', '[aria-current]', '[aria-describedby]',
  '[aria-details]', '[aria-disabled]', '[aria-dropeffect]', '[aria-errormessage]', '[aria-flowto]',
  '[aria-grabbed]', '[aria-haspopup]', '[aria-hidden]', '[aria-invalid]', '[aria-keyshortcuts]',
  '[aria-label]', '[aria-labelledby]', '[aria-live]', '[aria-owns]', '[aria-relevant]',
  '[aria-roledescription]',
].join(', ')

/** The role a snapshot gives a role-less element the page makes clickable. */
export const CLICKABLE_ROLE = 'clickable'

/** The role a snapshot gives an element a page draws as an icon and names nowhere. */
export const ICON_ROLE = 'icon'

/**
 * The word an icon-font library writes in the class of the element it draws an
 * icon on: `el-icon-edit`, `anticon-delete`, `icon-trash`, `iconfont`. It is the
 * one part of such a class name that is not a library's own spelling, which is
 * why this is the whole of what {@link iconWord} matches — a library that never
 * writes it is one this reader does not see.
 */
const ICON_TOKEN = 'icon'

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
 * The two ways a page takes an element out of what the reader sees outright:
 * HTML's own attribute, and the ARIA state that hides it from the reading
 * without changing how it is drawn. Both reach everything inside the element.
 */
const HIDDEN_SELECTOR = '[aria-hidden="true"], [hidden]'

/**
 * Elements a browser draws itself rather than laying out what is written inside
 * them: a picture built out of shapes, a media element, and a bar reporting a
 * quantity. What they hold is a part of the drawing, or a fallback for an
 * engine that cannot draw one, so the walk neither descends into one, reads its
 * text, nor counts a row inside it. What the page draws inside one and the
 * reader can still operate — a link drawn as a slice of a chart — stays a
 * control of the cell it sits in; see `cellControls`.
 */
const OPAQUE_SELECTOR = 'svg, canvas, video, audio, object, progress, meter'

/** How long one text run may be before it is cut. */
const TEXT_LIMIT = 200

/** How much of an over-long text run survives the cut, before the ellipsis. */
const TEXT_KEPT = 197

/** How much of the smaller rectangle two items must share to count as one. */
const OVERLAP_SHARE = 0.8

/** The keywords a page draws nothing around an element with. */
const DRAWS_NOTHING = /^(?:none|normal)$/u

/** Text that only separates the items either side of it. */
const SEPARATOR = /^[/>›»|:·•\-–—]+$/

/**
 * The code points a page writes to control how text breaks, joins, or runs
 * rather than to put a character on the screen: the zero-width space, the
 * joiners either side of it, the word joiner, a byte order mark left in the
 * text, the marks that set a direction, and the soft hyphen. Unicode's format
 * category is the whole of them, and none of them puts ink on the page.
 *
 * They are taken out to decide whether text draws anything and nowhere else:
 * text a read prints keeps every code point the page wrote. A browser draws none
 * of these and `\s` matches none of them, so a control holding one reads as a
 * control drawing text until they are taken out — the direction mark alone
 * inside a bar would stand in front of the number the page wrote for it.
 *
 * A code point a font draws as blank is not one of them. A braille space is a
 * character with a glyph, and a page writing one has drawn it.
 */
const FORMAT_CHARS = /\p{Cf}/gu

/**
 * Collapse every run of whitespace to one space and trim the ends.
 * @param value - raw text from the page.
 * @returns the collapsed text.
 */
export function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * True when text puts nothing on the screen: it is empty, or it holds nothing
 * but whitespace and the format code points a browser draws no character for.
 * A control whose contents draw nothing reports what the page wrote for it
 * instead, rather than a pair of quotes around an invisible character.
 * @param text - the collapsed text.
 * @returns whether the text draws nothing.
 */
export function drawsNothing(text: string): boolean {
  return collapse(text.replace(FORMAT_CHARS, '')) === ''
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
 *
 * The type is not the only way a page says so: a box with its own show/hide
 * toggle is a `text` box while the password is showing, and what it holds is
 * declared in `autocomplete` instead — `current-password` or `new-password`.
 * Both are read, because what the rule protects is the credential, not the
 * attribute.
 * @param el - the element to classify.
 * @returns whether the element is a password box.
 */
export function isPassword(el: Element): boolean {
  if (el.localName !== 'input') return false
  if (el.getAttribute('type')?.toLowerCase() === 'password') return true
  return el.getAttribute('autocomplete')?.toLowerCase().includes('password') ?? false
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
 * each other; ARIA resolves that in favour of what the element offers, for
 * `presentation` and its synonym `none` alike, and so does this.
 * @param el - the element to classify.
 * @returns the role name, or null for an element with no role ARIA knows.
 */
export function roleOf(el: Element): string | null {
  if (isPassword(el)) return 'textbox'
  // An empty role attribute declares nothing, and leaves the tag's own role.
  const declared = el.getAttribute('role')?.trim() ?? ''
  if (declared === '') return tagRole(el)
  const token = declared.split(/\s+/).find(name => KNOWN_ROLES.has(name)) ?? null
  if (token !== null && DECORATIVE_ROLES.has(token) && contradictsDecoration(el)) return implicitRole(el)
  return token
}

/**
 * True for an element the page has marked as decoration and then contradicted:
 * one a reader can focus, or one carrying a state or property ARIA defines on
 * every role, which a page writes only where it means the element to be read.
 * @param el - the element the page marked as decoration.
 * @returns whether the decoration is to be ignored.
 */
function contradictsDecoration(el: Element): boolean {
  return el.matches(FOCUSABLE_SELECTOR) || el.matches(GLOBAL_ARIA_SELECTOR)
}

/**
 * The role an element carries with nothing written on it. It is read from a
 * shallow copy with the attribute removed rather than from the element itself,
 * because `dom-accessibility-api` reads the first token alone and resolves this
 * conflict for `presentation` only: asked about the element as it stands, it
 * answers `none` for the very spelling the walk has decided to ignore.
 *
 * The copy stands outside the document, so the answer is the role of the tag
 * alone and never the one its position gives it: `header` answers `banner`
 * where the element itself is the head of a card, and `td` answers `cell` where
 * no table encloses it. Nothing follows from that today, because every role the
 * difference reaches is structural either way and landmarks are matched by tag
 * and attribute rather than by this answer. Giving one of those roles a
 * container face means reading the position too.
 * @param el - the element the page marked as decoration.
 * @returns the role name, or null for a tag HTML gives no role.
 */
function implicitRole(el: Element): string | null {
  const bare = el.cloneNode(false) as Element
  bare.removeAttribute('role')
  return tagRole(bare)
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
 * element, a bar. A path is not a paragraph, the title a drawing carries is a
 * tooltip the page never shows, and the words inside a `progress` are there for
 * an engine that cannot draw one.
 * @param el - the element to classify.
 * @returns whether the walk stops at the element rather than reading into it.
 */
export function isOpaque(el: Element): boolean {
  return el.matches(OPAQUE_SELECTOR)
}

/**
 * True for an element written inside one of those, which is no row of the page
 * however it is marked up: a link drawn as a slice of a chart is a part of the
 * picture, and the words a chart holds label the picture rather than naming
 * anything around it.
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
 * The roles whose control carries its own name inside itself: what a
 * `placeholder` writes is the word the user reads in the empty box, and a page
 * that labels such a box nowhere else has still told the user what it is.
 */
const PLACEHOLDER_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])

/**
 * The element's accessible name, and for a box the page named nowhere else,
 * the word written inside it.
 *
 * The placeholder is a fallback and never an override: a real name — a label,
 * `aria-label`, a title — is what the page said the control is, and this is
 * what is left when it said none. It is not the neighbouring-text rule the
 * reader deliberately does not have: the word is written on the control
 * itself, in the attribute whose whole purpose is to show it there, and it is
 * what a user reads in that box. A control with neither is left nameless,
 * which is what keeps `content_act` from being pointed at it at all.
 * @param el - the element to name.
 * @returns the collapsed name, empty when the element has none.
 */
export function nameOf(el: Element): string {
  const computed = clip(collapse(computeAccessibleName(el)))
  if (computed !== '') return computed
  const role = roleOf(el)
  if (role === null || !PLACEHOLDER_ROLES.has(role)) return ''
  const written = el.getAttribute('placeholder') ?? el.getAttribute('aria-placeholder') ?? ''
  return clip(collapse(written))
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
  return isNonContent(el) || el.matches(HIDDEN_SELECTOR) || !isVisible(el)
}

/**
 * True for an element hidden by something around it as well as by itself. The
 * injected visibility already answers for the styling, which reaches an element
 * from every ancestor over it; the two attributes are read again over the
 * ancestors because `aria-hidden` changes no style at all, so a wrapper
 * carrying it hides what is inside however the page draws it.
 *
 * The walk itself never needs this — it stops at the wrapper and never reaches
 * what is inside — and the searches that look at one element without walking to
 * it do.
 * @param el - the element to classify.
 * @param isVisible - injected visibility.
 * @returns whether the element is drawn nowhere the reader looks.
 */
export function isHiddenAround(el: Element, isVisible: (el: Element) => boolean): boolean {
  return isSkipped(el, isVisible) || el.closest(HIDDEN_SELECTOR) !== null
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
 * The text one attribute holds. An attribute the page left empty says nothing
 * rather than saying the empty string, the way an empty `aria-label` names
 * nothing: a bar carrying `aria-valuetext=""` is a bar whose next source of a
 * value is the one to read.
 * @param el - the element to read.
 * @param name - the attribute name.
 * @returns the collapsed text, or undefined when the page wrote none.
 */
function writtenText(el: Element, name: string): string | undefined {
  const value = clip(collapse(el.getAttribute(name) ?? ''))
  return value === '' ? undefined : value
}

/**
 * What a bar reports: the text the page wrote for it, the number behind that
 * text, or the value a native bar carries. A bar carrying none of the three
 * draws whatever it means somewhere else, and reports nothing here.
 * @param el - the bar element.
 * @returns the value, or undefined for a bar that reports none.
 */
export function quantityValue(el: Element): string | undefined {
  const declared = writtenText(el, 'aria-valuetext') ?? writtenText(el, 'aria-valuenow')
  if (declared !== undefined) return declared
  const tag = el.localName
  return tag === 'progress' || tag === 'meter' ? writtenText(el, 'value') : undefined
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
 *
 * The attribute is read the way HTML reads an enumerated one, ignoring case and
 * surrounding space: a page that wrote `TRUE` said the box is on.
 * @param el - the element to read.
 * @returns its checked state, or undefined when the page has declared none.
 */
export function isChecked(el: Element): boolean | undefined {
  if (el.localName === 'input') return (el as HTMLInputElement).checked
  const aria = el.getAttribute('aria-checked')?.trim().toLowerCase()
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
 * Whether the page takes what a field holds and refuses to let the reader type
 * over it. A page draws a picker as a box it fills itself, so a reader told
 * nothing would type into a field that answers no key.
 * @param el - the element to read.
 * @returns its read-only state.
 */
export function isReadonly(el: Element): boolean {
  if (el.getAttribute('aria-readonly') === 'true') return true
  const tag = el.localName
  return (tag === 'input' || tag === 'textarea') && (el as HTMLInputElement).readOnly
}

/**
 * The default clickability test: a page that gives a role-less element a
 * pointer cursor is telling the reader it can be clicked.
 * @param el - the element to classify.
 * @returns whether the element looks clickable.
 */
export function looksClickable(el: Element): boolean {
  return viewOf(el).getComputedStyle(el).cursor === 'pointer'
}

/**
 * The window an element's own document is drawn in, which is the one that
 * answers for its styles: an element of a frame is laid out by that frame, and
 * a document no window renders is answered for by the window this code runs in.
 * @param el - the element to read.
 * @returns the window to ask about it.
 */
function viewOf(el: Element): Window {
  return el.ownerDocument.defaultView ?? window
}

/**
 * The text a page draws around an element rather than writing it in the
 * document: the star a form draws in front of the label of a field that must be
 * filled, and whatever else `::before` and `::after` put on the screen. A
 * reader sees it and no read of the document can reach it.
 *
 * The quotes CSS puts around drawn text belong to the stylesheet rather than to
 * the page, and the keywords for drawing nothing draw nothing.
 * @param el - the element to read.
 * @returns the collapsed text, empty where the page draws none.
 */
export function drawnAround(el: Element): string {
  return collapse(`${drawnPart(el, '::before')} ${drawnPart(el, '::after')}`)
}

/**
 * The text one of those two draws.
 * @param el - the element to read.
 * @param part - the pseudo-element to read.
 * @returns the text, empty where it draws none.
 */
function drawnPart(el: Element, part: string): string {
  return viewOf(el).getComputedStyle(el, part).content.replace(DRAWS_NOTHING, '').replaceAll(/["']/gu, '')
}

/**
 * The word one class token or one symbol id names an icon with: whatever a page
 * writes after the word `icon`. `el-icon-edit`, `icon-edit`, and `anticon-delete`
 * each say what they draw; `el-icon`, `edit-icon`, and `iconfont` say only that
 * something is an icon, and a name written without the word at all — the `trash`
 * of a `#trash` symbol — is the whole of what it says.
 * @param token - one class token, or the id a sprite reference points at.
 * @returns the word, or undefined when the token names nothing but an icon.
 */
function iconPart(token: string): string | undefined {
  const parts = token.split(/[-_]/u).filter(part => part !== '')
  const at = parts.findIndex(part => part.toLowerCase().includes(ICON_TOKEN))
  return parts.slice(at + 1).at(-1)
}

/**
 * The word a page's classes name an icon with.
 * @param el - the element to read.
 * @returns the word, empty for classes that mark an icon and name none, and
 * undefined for an element no class marks as an icon.
 */
function classIconWord(el: Element): string | undefined {
  const tokens = [...el.classList]
  const at = tokens.findIndex(token => token.toLowerCase().includes(ICON_TOKEN))
  if (at === -1) return undefined
  for (const token of tokens.slice(at)) {
    const word = iconPart(token)
    if (word !== undefined) return word
  }
  return ''
}

/**
 * The one drawing an element holds and nothing else, which is how every icon
 * set drawn as inline `svg` is wrapped: the wrapper carries the classes and the
 * drawing carries the shape.
 * @param el - the element to look inside.
 * @returns the drawing, or undefined for an element holding anything else.
 */
export function drawingInside(el: Element): Element | undefined {
  const children = [...el.children]
  const only = children.length === 1 ? children[0] : undefined
  return only?.localName === 'svg' ? only : undefined
}

/**
 * The drawing one element's name can be read from: itself, where it is one, and
 * the drawing a wrapper the page marks as an icon holds and nothing else. A
 * wrapper the page marks as nothing stays a wrapper, because pages draw far
 * more decoration than icons and the drawing inside one of those names nothing
 * anybody asked for.
 * @param el - the element to read.
 * @param classed - what the element's own classes say, from {@link classIconWord}.
 * @returns the drawing, or undefined where there is none to read.
 */
function namedDrawing(el: Element, classed: string | undefined): Element | undefined {
  if (el.localName === 'svg') return el
  return classed === undefined ? undefined : drawingInside(el)
}

/**
 * The word a drawing names itself with: the symbol a sprite reference points
 * at, or the title the drawing carries. A page that draws its icons as inline
 * `svg` writes the name in one of those two places or in neither. A title is
 * read here as well as through the accessible name, because the wrapper an icon
 * set puts around the drawing carries no name of its own and computes none from
 * a title one element further in.
 * @param el - the element to read: a drawing, or the wrapper around one.
 * @param classed - what the element's own classes say, from {@link classIconWord}.
 * @param isVisible - injected visibility.
 * @returns the word, empty for a drawing marked as an icon and named nothing,
 * and undefined when there is no drawing to name.
 */
function drawnIconWord(el: Element, classed: string | undefined, isVisible: (el: Element) => boolean): string | undefined {
  const drawing = namedDrawing(el, classed)
  if (drawing === undefined) return undefined
  const use = drawing.querySelector('use')
  const href = use?.getAttribute('href') ?? use?.getAttribute('xlink:href') ?? ''
  const hash = href.lastIndexOf('#')
  if (hash !== -1) return iconPart(href.slice(hash + 1)) ?? ''
  const title = drawing.querySelector('title')
  return title === null ? undefined : clip(visibleText(title, isVisible))
}

/**
 * The name a page's own markup gives an icon, for one it draws and labels
 * nowhere: the word its classes carry, the symbol a sprite reference points at,
 * or the title of the drawing itself.
 *
 * This is the one rule in the package keyed to what a page happens to write
 * rather than to what a specification defines, and it is a heuristic: only the
 * word `icon` counts, in any class token that holds it, and no library's own
 * prefix is matched — `el-`, `anticon`, and `iconfont` reach it through `icon`
 * alone, and a library spelling its icons some other way reaches it not at all.
 * A drawing is read whatever its classes say, because an icon set drawn as
 * inline `svg` writes its name in the symbol it points at instead; a drawing
 * that names itself nowhere is decoration, and pages draw far too many of those
 * to print a row for each.
 * @param el - the element to read.
 * @param isVisible - injected visibility.
 * @returns the name, empty for markup that marks an icon and names none, and
 * undefined for an element the page marks as no icon at all.
 */
export function iconWord(el: Element, isVisible: (el: Element) => boolean): string | undefined {
  const classed = classIconWord(el)
  if (classed !== undefined && classed !== '') return classed
  const drawn = drawnIconWord(el, classed, isVisible)
  if (drawn !== undefined && drawn !== '') return drawn
  return classed ?? drawn
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

/**
 * True when two rectangles cover any of the same ground at all, which is what
 * tells a table drawn over another from the table drawn after it: a page pins a
 * column by drawing the whole table again on top of itself, while a second
 * table below the first shares an edge with it at most. A page that reports no
 * rectangle for one of them has said nothing about where it is drawn, and the
 * two are then not one thing.
 * @param a - the first rectangle, absent where the page reports none.
 * @param b - the second rectangle, absent where the page reports none.
 * @returns whether the two are drawn over each other.
 */
export function rectsMeet(a: DOMRectReadOnly | undefined, b: DOMRectReadOnly | undefined): boolean {
  if (a === undefined || b === undefined) return false
  return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
}
