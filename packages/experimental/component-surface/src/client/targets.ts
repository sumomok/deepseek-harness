/**
 * The targets one call resolves inside one drawn entry: the block it is
 * confined to, the control a key names, the field a name addresses, and whether
 * a person could reach either.
 *
 * Every search is bounded by a subtree of the entry's own container, and every
 * key or name is the block's own declaration (`data-component-action`,
 * `data-component-key`, `data-component-field`, `data-component-node`), so a
 * control the entry does not declare names nothing. The step executor and the
 * reader both resolve through this module, so a control a reading describes is
 * the element a step naming it reaches.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/targets
 */

import type { DrawnEntry } from './entry-container.ts'

/** The controls a `set` step may write into. */
export const WRITABLE = 'input, textarea, select'

/** The parts of a form control a `set` step may match a name against. */
const NAMED_BY = ['aria-label', 'name', 'placeholder'] as const

/** The attribute an element carrying one action key is marked with. */
export const ACTION_KEY = 'data-component-action'

/**
 * The attribute a control's own key is marked with where several controls
 * perform one declared action, as a confirmation bar's buttons do: a step naming
 * the key presses that control, one naming the action presses the first.
 */
export const OWN_KEY = 'data-component-key'

/** The attribute naming the block an element is drawn by. */
export const NODE_KEY = 'data-component-node'

/**
 * The attribute naming the column or property a `set` step may write; the
 * controls of a block that declares none are named by {@link ownName}.
 */
export const FIELD_KEY = 'data-component-field'

/** The roles a block draws a dialog or an overlay with, as the platform names them. */
export const OVERLAY = '[role="dialog"], [aria-modal="true"]'

/** The elements a drawn table draws one row of records in, as the platform names them. */
export const ROW = 'tr, [role="row"]'

/**
 * The vendored page's element holding its words for how many records its query
 * matched, reported as written in the deployment's language.
 */
export const PAGER_TOTAL = '.el-pagination__total'

/** The element-ui select one field control is drawn inside, which is what makes the field a select. */
export const SELECT = '.el-select'

/** One select's drawn options, a child of the select itself since this row contains its list. */
export const SELECT_OPTION = '.el-select-dropdown__item'

/** The input element-ui draws one select's own text in. */
export const SELECT_INPUT = 'input.el-input__inner'

/** The element-ui autocomplete one field control is drawn inside, which is what makes the field a suggestion field. */
export const AUTOCOMPLETE = '.el-autocomplete'

/** One autocomplete's drawn suggestions, children of the autocomplete since this row contains its panel. */
export const AUTOCOMPLETE_OPTION = '.el-autocomplete-suggestion__list > li'

/**
 * The icon element-ui draws in an autocomplete's asking row while a query is
 * out, which is what tells that row apart from a choice.
 */
const LOADING_ICON = '.el-icon-loading'

/**
 * One element's own attribute value, compared exactly.
 * @param el - the element.
 * @param attribute - the attribute to read.
 * @param value - the value it must carry.
 * @returns whether it carries it.
 */
export function marked(el: Element, attribute: string, value: string): boolean {
  return el.getAttribute(attribute) === value
}

/**
 * Every element of one subtree carrying an attribute, in document order. Values
 * are compared by the caller rather than spliced into a selector, so a key
 * holding a quote or a space matches nothing instead of changing the query.
 * @param root - the subtree to search, itself included.
 * @param attribute - the attribute every candidate carries.
 * @returns the candidates.
 */
export function withAttribute(root: Element, attribute: string): Element[] {
  const found = [...root.querySelectorAll(`[${attribute}]`)]
  if (root.hasAttribute(attribute)) found.unshift(root)
  return found
}

/**
 * The element one step's block names, or the entry's own container.
 * @param entry - the drawn entry.
 * @param node - the block id the step named, absent for the whole entry.
 * @returns the subtree to search in, or undefined when the block is not drawn.
 */
export function scopeOf(entry: DrawnEntry, node: string | undefined): Element | undefined {
  if (node === undefined) return entry.container
  return withAttribute(entry.container, NODE_KEY).find(el => marked(el, NODE_KEY, node))
}

/**
 * The control one `click` step presses: the first drawn ({@link isDrawn})
 * control carrying the key as its declared action ({@link ACTION_KEY}), else as
 * its own key ({@link OWN_KEY}). A block keeps closed controls — a row's
 * confirmation bubble, a closed dialog — in the document, and a press must land
 * where a person's could, so undrawn candidates are passed over.
 * @param scope - the subtree the step is confined to.
 * @param key - the action key, or the control's own key, the step names.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the drawn element, or undefined when the subtree draws none for the key.
 */
export function clickTarget(scope: Element, key: string, within: Element): Element | undefined {
  for (const attribute of [ACTION_KEY, OWN_KEY]) {
    const found = withAttribute(scope, attribute).find(el => marked(el, attribute, key) && isDrawn(el, within))
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Whether one subtree holds the key on a control it does not draw. Asked after
 * {@link clickTarget} found none, so `true` means every control carrying the
 * key is undrawn rather than absent.
 * @param scope - the subtree the step is confined to.
 * @param key - the action key, or the control's own key, the step names.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns whether an undrawn control carries the key.
 */
export function undrawnTarget(scope: Element, key: string, within: Element): boolean {
  for (const attribute of [ACTION_KEY, OWN_KEY]) {
    if (withAttribute(scope, attribute).some(el => marked(el, attribute, key) && !isDrawn(el, within))) return true
  }
  return false
}

/**
 * One form control's own name: its `aria-label`, `name`, or `placeholder`, else
 * the text of a `label[for]` inside the entry, so the console's words outside
 * the entry never decide which field a call writes. Each label's `for` is
 * compared rather than spliced into a selector: an id is unvalidated block
 * markup, and one holding a quote would make the selector throw for every `set`
 * searching that entry.
 * @param el - the control.
 * @param within - the entry's own container.
 * @returns the name it carries there, empty when it carries none.
 */
export function ownName(el: Element, within: Element): string {
  for (const attribute of NAMED_BY) {
    const value = el.getAttribute(attribute)
    if (value !== null && value !== '') return value
  }
  const id = el.getAttribute('id')
  if (id === null || id === '') return ''
  for (const label of within.querySelectorAll('label[for]')) {
    if (label.getAttribute('for') === id) return label.textContent.trim()
  }
  return ''
}

/**
 * Whether one element is drawn where a person could use it: neither it nor an
 * ancestor inside the container carries `hidden` or computes to `display: none`
 * or `visibility: hidden`, which is how a closed dialog keeps its fields.
 * @param el - the element.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns whether it is drawn.
 */
export function isDrawn(el: Element, within: Element): boolean {
  for (let node: Element | null = el; node !== null && node !== within; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return false
    const shown = getComputedStyle(node)
    if (shown.display === 'none' || shown.visibility === 'hidden') return false
  }
  return true
}

/**
 * The open dialog one field is drawn inside, when it is drawn inside one.
 * @param el - the field.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the dialog's element, or undefined when the field is not in an open one.
 */
export function openDialog(el: Element, within: Element): Element | undefined {
  for (let node: Element | null = el.parentElement; node !== null && node !== within; node = node.parentElement) {
    if (node.matches(OVERLAY) && isDrawn(node, within)) return node
  }
  return undefined
}

/**
 * The row (`tr` or `role="row"`) one element is inside. A toolbar, query panel,
 * or dialog footer is outside every row and belongs to the scope, which is how a
 * reading separates controls it lists once from those it folds into a row.
 * @param el - the element.
 * @param within - the scope's own element, past which nothing is asked.
 * @returns the row, or undefined when the element is not drawn inside one.
 */
export function rowOf(el: Element, within: Element): Element | undefined {
  for (let node: Element | null = el; node !== null && node !== within; node = node.parentElement) {
    if (node.matches(ROW)) return node
  }
  return undefined
}

/**
 * The records one list of drawn rows holds, merging the rows at one position in
 * each container. A table with fixed columns draws every row in its scrolling
 * body and again in each fixed layer, in one order; two different tables of
 * equal length under one block would be paired too, and no block of this row
 * draws that.
 * @param rows - the drawn row elements, in document order.
 * @returns one entry per record, each holding that record's copies, first drawn first.
 */
export function rowCopies(rows: readonly Element[]): Element[][] {
  const byContainer = new Map<Element | null, Element[]>()
  for (const row of rows) {
    const container = row.parentElement
    const held = byContainer.get(container)
    if (held === undefined) byContainer.set(container, [row])
    else held.push(row)
  }
  const merged: Element[][] = []
  for (const held of byContainer.values()) {
    for (const [at, row] of held.entries()) {
      const copies = merged[at]
      if (copies === undefined) merged[at] = [row]
      else copies.push(row)
    }
  }
  return merged
}

/**
 * The page's own words for how many records its query matched, read from its
 * drawn pager total with whitespace collapsed.
 * @param within - the scope's own element, past which nothing is asked.
 * @returns the words, or undefined where no drawn pager total is there to read.
 */
export function pagerTotal(within: Element): string | undefined {
  const total = [...within.querySelectorAll(PAGER_TOTAL)].find(el => isDrawn(el, within))
  const words = (total?.textContent ?? '').replace(/\s+/g, ' ').trim()
  return words === '' ? undefined : words
}

/**
 * Every control under one scope whose own accessible name is the one a step named.
 * @param scope - the subtree the step is confined to.
 * @param name - the column or property the step named.
 * @param within - the entry's own container, which bounds what may name a field.
 * @returns the controls, in document order.
 */
export function namedControls(scope: Element, name: string, within: Element): Element[] {
  const controls = [...scope.querySelectorAll(WRITABLE)]
  if (scope.matches(WRITABLE)) controls.unshift(scope)
  return controls.filter(el => ownName(el, within) === name)
}

/**
 * The element-ui select one field control belongs to. A component-kit block
 * draws the select's list inside the select, so its options are reachable from
 * the element the entry declares; a select wrapping the entry from outside does
 * not count, since its options lie outside the confine.
 * @param control - the field's control.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the select element, or undefined when the control is not a select's.
 */
export function selectOf(control: Element, within: Element): Element | undefined {
  const select = control.closest(SELECT)
  return select === null || !within.contains(select) ? undefined : select
}

/**
 * Every option one select draws, in document order. The options are mounted
 * with the list hidden, so they are drawn once the list opens, and an option a
 * filter or a closed group removed stays undrawn.
 * @param select - the select element.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the drawn option elements.
 */
export function selectOptions(select: Element, within: Element): Element[] {
  return [...select.querySelectorAll(SELECT_OPTION)].filter(option => isDrawn(option, within))
}

/**
 * The element-ui autocomplete one field control belongs to; as with
 * {@link selectOf}, one wrapping the entry from outside does not count.
 * @param control - the field's control.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the autocomplete element, or undefined when the control is not an autocomplete's.
 */
export function autocompleteOf(control: Element, within: Element): Element | undefined {
  const autocomplete = control.closest(AUTOCOMPLETE)
  return autocomplete === null || !within.contains(autocomplete) ? undefined : autocomplete
}

/**
 * Every suggestion one autocomplete draws, in document order, without the
 * loading row element-ui draws while a query is out, which holds no choice.
 * @param autocomplete - the autocomplete element.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the drawn suggestion elements.
 */
export function autocompleteOptions(autocomplete: Element, within: Element): Element[] {
  return [...autocomplete.querySelectorAll(AUTOCOMPLETE_OPTION)]
    .filter(option => isDrawn(option, within) && option.querySelector(LOADING_ICON) === null)
}

/**
 * Whether one autocomplete draws its loading row. element-ui draws it from the
 * moment a query leaves until the answer lands, and an empty answer closes the
 * panel without drawing a suggestion, so the row going with nothing behind it
 * is the only sign of an empty answer.
 * @param autocomplete - the autocomplete element.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns whether the asking row is drawn.
 */
export function autocompleteAsking(autocomplete: Element, within: Element): boolean {
  return [...autocomplete.querySelectorAll(AUTOCOMPLETE_OPTION)]
    .some(option => isDrawn(option, within) && option.querySelector(LOADING_ICON) !== null)
}

/**
 * Whether one node a mutation added is an autocomplete's asking row, or holds
 * one. Read off the node itself rather than by where it stands, because the
 * mutation an observer hands over may carry a row the block already took away,
 * and a detached element no longer matches a selector naming its parent.
 * @param node - the node one mutation added.
 * @returns whether it is that row, or holds one.
 */
export function addedAskingRow(node: Node): boolean {
  return node instanceof Element && node.querySelector(LOADING_ICON) !== null
}

/**
 * What one drawn element shows as its label: an option's text, or a tag's.
 * @param el - the option or tag.
 * @returns the label, trimmed.
 */
export function optionLabel(el: Element): string {
  return el.textContent.trim()
}

/**
 * The labels one select displays as its value: its own input's text for a
 * single select, one tag per chosen option for a multiple one.
 * @param select - the select element.
 * @returns the labels it displays, in the order drawn.
 */
export function selectShows(select: Element): string[] {
  return [...select.querySelectorAll(`.el-select__tags-text, ${SELECT_INPUT}`)]
    .map(el => (el instanceof HTMLInputElement ? el.value : optionLabel(el)))
    .filter(shown => shown !== '')
}

/**
 * Whether a block has disabled one control: `:disabled` (its own attribute or
 * an ancestor `<fieldset disabled>`) or `aria-disabled="true"`. A browser runs
 * no handler through a disabled control, so a press of one would report a
 * press that did nothing.
 * @param el - the control.
 * @returns whether it is disabled.
 */
export function isDisabled(el: Element): boolean {
  return el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true'
}

/**
 * Whether the topmost element at a control's point reaches the control: the
 * control itself, something inside it, the label carrying it (an `el-checkbox`
 * hides its input under its label), or a {@link secondDrawing} of it.
 * @param top - the topmost element at the control's own point.
 * @param target - the control a press is aimed at.
 * @returns whether a click there reaches the control.
 */
function reaches(top: Element, target: Element): boolean {
  if (top === target || target.contains(top)) return true
  const label = top.closest('label')
  if (label !== null && label.control === target) return true
  return secondDrawing(top, target)
}

/**
 * Whether the element on top is a second drawing of the same control: a table
 * draws its fixed columns' controls again in a layer over the originals, and
 * the copy carries the same action, own key, tag, and block.
 * @param top - the topmost element at the control's own point.
 * @param target - the control a press is aimed at.
 * @returns whether the point reaches the same control.
 */
function secondDrawing(top: Element, target: Element): boolean {
  const action = target.getAttribute(ACTION_KEY)
  if (action === null) return false
  const key = target.getAttribute(OWN_KEY)
  const block = target.closest(`[${NODE_KEY}]`)
  for (let el: Element | null = top; el !== null; el = el.parentElement) {
    if (el.getAttribute(ACTION_KEY) === action && el.getAttribute(OWN_KEY) === key
      && el.tagName === target.tagName && el.closest(`[${NODE_KEY}]`) === block) return true
  }
  return false
}

/**
 * Whether something else is drawn over the control at its centre, by the
 * document's own hit test. A control with no box (a hidden input, or a document
 * with no layout) and a point outside the rendered page count as uncovered.
 * @param target - the control a press is aimed at.
 * @returns whether it is covered.
 */
export function isCovered(target: Element): boolean {
  const rect = target.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return top !== null && !reaches(top, target)
}
