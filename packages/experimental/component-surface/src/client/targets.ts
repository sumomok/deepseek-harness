/**
 * The targets one call resolves inside one drawn entry: which block it is
 * confined to, the control a key names, the field a name addresses, and whether
 * either is one a person could reach.
 *
 * Every search here is bounded by a subtree of the entry's own container and
 * nowhere else, and every key or name comes from the block's own declaration
 * (`data-component-action`, `data-component-key`, `data-component-field`,
 * `data-component-node`) rather than from a DOM reference. That is what makes
 * the confine hold: a control the entry does not declare is a target that
 * names nothing, whatever else the console draws.
 *
 * Both halves of this package's acting vocabulary resolve through here — the
 * step executor that presses and writes, and the reader that reports what is
 * drawn — so a control a reading describes is the exact element a step naming
 * it would reach, and one declaration of reach cannot drift from the other.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/targets
 */

import type { DrawnEntry } from './entry-container.ts'

/** The controls a `set` step may write into. */
export const WRITABLE = 'input, textarea, select'

/** The parts of a form control a `set` step may match a name against. */
const NAMED_BY = ['aria-label', 'name', 'placeholder'] as const

/**
 * The attribute an element carrying one action key is marked with.
 *
 * The attribute is read and the key compared in the page rather than turned
 * into a selector, for the reason {@link withAttribute} states.
 */
export const ACTION_KEY = 'data-component-action'

/**
 * The attribute a control carrying its own key is marked with, for a component
 * whose one declared action is performed by several controls: a confirmation
 * bar's buttons each carry the bar's `press` action and their own id, and a
 * step naming the id presses that button while one naming the action presses
 * the first. Absent on controls that have no key of their own.
 */
export const OWN_KEY = 'data-component-key'

/** The attribute naming the block an element is drawn by. */
export const NODE_KEY = 'data-component-node'

/**
 * The attribute a field is named with: the column or property a `set` step may
 * write. Read where a block declares its fields outright; a block that declares
 * none has its controls named by what they carry, for the reason
 * {@link ownName} states.
 */
export const FIELD_KEY = 'data-component-field'

/** The roles a block draws a dialog or an overlay with, as the platform names them. */
export const OVERLAY = '[role="dialog"], [aria-modal="true"]'

/** The elements a drawn table draws one row of records in, as the platform names them. */
export const ROW = 'tr, [role="row"]'

/**
 * The vendored page's own element holding the words for how many records its
 * query matched.
 *
 * The words are reported rather than the number parsed out of them: they are
 * the page's own sentence in the deployment's language, and which of its words
 * is the count is the page's to say.
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

/**
 * One autocomplete's drawn suggestions, children of the autocomplete itself
 * since this row contains its panel.
 */
export const AUTOCOMPLETE_OPTION = '.el-autocomplete-suggestion__list > li'

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
 * Every element of one subtree carrying an attribute, in document order.
 *
 * Attributes are read and compared in the page rather than turned into a
 * selector, so a key with a quote or a space in it is a key that matches
 * nothing rather than one that changes what the query means.
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
  const found = withAttribute(entry.container, NODE_KEY).find(el => marked(el, NODE_KEY, node))
  return found === undefined ? undefined : found
}

/**
 * The control one `click` step presses.
 *
 * Two keys address one control, and both are the component's own declaration
 * rather than anything this package invents: the action the block declares
 * ({@link ACTION_KEY}), and — where one action is performed by several controls
 * that each carry a key of their own — that key ({@link OWN_KEY}). The action
 * key is looked for first, so a step naming an action the block declares
 * presses its first control whatever the controls call themselves.
 *
 * The control resolved is one the block draws ({@link isDrawn}): a block keeps
 * controls in the document while they are closed — a row's confirmation bubble,
 * a dialog that was closed — and the copies a search meets first are those
 * kept ones. A press must land where a person's could, so an undrawn candidate
 * is passed over for a drawn one, and a key only undrawn controls carry is a
 * step that names nothing this call may press rather than a press of an
 * element nobody sees. This is the rule a reading of the same key goes through
 * too, so the control a reading describes is one a step naming it would reach.
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
 * Whether one subtree holds the key on a control it does not draw.
 *
 * Asked only after {@link clickTarget} found nothing: the key exists somewhere
 * in the block and every control carrying it is undrawn, which is the refusal
 * that says so rather than one claiming the entry does not hold the key.
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
 * Where one form control's own name is written.
 *
 * The label is looked up inside the entry as well: a `for` pointing outside it
 * would otherwise let the console's own words decide which field a call writes,
 * and this step's whole confine is that one entry.
 *
 * The labels are read and their `for` compared rather than spliced into a
 * selector: an id is the block's own markup, which nothing here validates, and
 * one carrying a quote or a bracket would make the selector invalid — the
 * engine's own error would reach the model, and one such control would break
 * every `set` searching that entry.
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
    if (label.getAttribute('for') !== id) continue
    /* v8 ignore next -- an element's textContent is null only for a document node, and a label is an element */
    return (label.textContent ?? '').trim()
  }
  return ''
}

/**
 * Whether one element is drawn where a person could use it.
 *
 * A block that holds something back says so the way the platform does — the
 * `hidden` attribute, or a computed `display`/`visibility` that takes it away —
 * and a dialog keeps its fields in the document that way while it is closed.
 * What a document draws is drawn: there is nothing else to ask, and a document
 * with no layout (jsdom) resolves a value the block wrote inline exactly as a
 * browser resolves it.
 * @param el - the element.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns whether it is drawn.
 */
export function isDrawn(el: Element, within: Element): boolean {
  for (let node: Element | null = el; node !== within; node = node.parentElement) {
    /* v8 ignore next -- every candidate is inside the entry, so the walk reaches the container first */
    if (node === null) break
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
  for (let node: Element | null = el.parentElement; node !== within; node = node.parentElement) {
    /* v8 ignore next -- every field is inside the entry, so the walk reaches the container first */
    if (node === null) break
    if (node.matches(OVERLAY) && isDrawn(node, within)) return node
  }
  return undefined
}

/**
 * The drawn row one element is inside, when it is drawn inside one.
 *
 * A row is what the platform says a row is: a `tr`, or anything carrying the
 * row role. What stands outside every row — a toolbar, a query panel, a
 * dialog's footer — is the scope's own and is reported as such, which is the
 * difference between the controls a reading lists once and the ones it folds
 * into what a row draws.
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
 * The drawn rows one list of rows holds, merged by the position each is drawn at.
 *
 * A table with fixed columns draws every row more than once — the scrolling
 * body and each fixed layer hold a copy of it — and the copies are one record
 * as the person reading the page sees it: the same position in each wrapper,
 * holding the columns that wrapper draws. Merging them by position is what makes
 * the reading count records rather than elements, and it is the same pairing a
 * step's own search makes when it passes over a second drawing of a control: the
 * first copy in document order is the one a person's click reaches.
 *
 * The pairing assumes the copies are drawn in one order, which is what puts the
 * same position in every wrapper on the same record; two genuinely different
 * tables drawing the same number of rows under one block would pair their rows,
 * and no block of this row does that.
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
 * The page's own words for how many records its query matched, where it draws them.
 *
 * Read where the page draws its pager, which is a part of the page rather than
 * a target any step addresses: what the reading says about it is what the page
 * says, without narrowing it to the drawn rows or interpreting its language.
 * @param within - the scope's own element, past which nothing is asked.
 * @returns the words, or undefined where no drawn pager total is there to read.
 */
export function pagerTotal(within: Element): string | undefined {
  const total = [...within.querySelectorAll(PAGER_TOTAL)].find(el => isDrawn(el, within))
  /* v8 ignore next -- an element's textContent is null only for a document node, and this is an element */
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
 * The select one field control belongs to, when that control is a select's own.
 *
 * A component-kit block draws element-ui's select with its list inside the
 * select itself, so a control under `.el-select` is one whose value is chosen
 * from a list rather than typed, and the list is reachable from the same
 * element the entry declares. The select counts only while it stands inside the
 * entry: one wrapping the entry from outside would hold options the confine
 * does not cover, and a step that chose among them would be writing outside the
 * entry it named.
 *
 * This is the resolution any reading of the same field goes through too: one
 * definition of which element is a select and which options it draws, so what a
 * reading of a field describes is what a `set` step on it reaches.
 * @param control - the field's control.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the select element, or undefined when the control is not a select's.
 */
export function selectOf(control: Element, within: Element): Element | undefined {
  const select = control.closest(SELECT)
  return select === null || !within.contains(select) ? undefined : select
}

/**
 * Every option one select draws, in document order.
 *
 * A select's options are in the document from the mount with the list hidden,
 * so what is drawn is what a step waits for: the open is what takes the hidden
 * state off the list, and an option a filter or a closed group has taken away
 * stays undrawn. The same reading is what a reader reports as the options a
 * select currently offers.
 * @param select - the select element.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the drawn option elements.
 */
export function selectOptions(select: Element, within: Element): Element[] {
  return [...select.querySelectorAll(SELECT_OPTION)].filter(option => isDrawn(option, within))
}

/**
 * The autocomplete one field control belongs to, when that control is an
 * autocomplete's own.
 *
 * The same confine the select's own resolution states applies: an autocomplete
 * wrapping the entry from outside would hold suggestions this call may not
 * reach, so it counts only while it stands inside the entry.
 * @param control - the field's control.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the autocomplete element, or undefined when the control is not an autocomplete's.
 */
export function autocompleteOf(control: Element, within: Element): Element | undefined {
  const autocomplete = control.closest(AUTOCOMPLETE)
  return autocomplete === null || !within.contains(autocomplete) ? undefined : autocomplete
}

/**
 * Every suggestion one autocomplete draws, in document order.
 *
 * The panel holds the block's answer while it stands; the row the component
 * draws while it is still asking — the one carrying the loading icon — is not
 * a suggestion, and counting it would end a step's wait on a list that holds
 * no choice yet.
 * @param autocomplete - the autocomplete element.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the drawn suggestion elements.
 */
export function autocompleteOptions(autocomplete: Element, within: Element): Element[] {
  return [...autocomplete.querySelectorAll(AUTOCOMPLETE_OPTION)]
    .filter(option => isDrawn(option, within) && option.querySelector('.el-icon-loading') === null)
}

/**
 * What one drawn element shows as its label: an option's text, or a tag's.
 * @param el - the option or tag.
 * @returns the label, trimmed.
 */
export function optionLabel(el: Element): string {
  /* v8 ignore next -- an element's textContent is null only for a document node, and an option is an element */
  return (el.textContent ?? '').trim()
}

/**
 * What one select displays as the value it holds.
 *
 * element-ui draws a single select's value as the text of the select's own
 * input and a multiple select's as one tag per chosen option; both are the
 * component's own rendering of the value, which is what a step confirms its
 * choice against.
 * @param select - the select element.
 * @returns the labels it displays, in the order drawn.
 */
export function selectShows(select: Element): string[] {
  return [...select.querySelectorAll(`.el-select__tags-text, ${SELECT_INPUT}`)]
    .map(el => (el instanceof HTMLInputElement ? el.value : optionLabel(el)))
    .filter(shown => shown !== '')
}

/**
 * Whether a block has disabled one control.
 *
 * A block says so the ways the platform does — the `disabled` attribute a form
 * control carries, an ancestor `<fieldset disabled>` the platform disables
 * everything under while the controls themselves carry no attribute, and
 * `aria-disabled` for anything else. The first two are one question to the
 * platform (`:disabled`), which is also what a person's browser asks before it
 * refuses the click. A press of such a control would be reported as one that
 * ran while the block's own handler, which a real browser never calls through
 * a disabled control, never ran.
 * @param el - the control.
 * @returns whether it is disabled.
 */
export function isDisabled(el: Element): boolean {
  if (el.matches(':disabled')) return true
  if (el.getAttribute('aria-disabled') === 'true') return true
  const disabled: unknown = (el as { readonly disabled?: unknown }).disabled
  return disabled === true
}

/**
 * Whether one element of a hit test is the control a press would reach.
 *
 * The element a person's click would land on is the control itself, something
 * inside it, or the label that carries it: an `el-checkbox` hides its own input,
 * so the point over it lands on the label's box while a click there still
 * toggles that input, and the two are one control. A second drawing of the same
 * control reaches it as well, for the reason {@link secondDrawing} states.
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
 * Whether the element on top is a second drawing of the same control.
 *
 * A block that draws one control twice — a table splits its fixed columns into
 * a layer of its own and draws each of their controls again there — leaves the
 * copy standing over the one a step found. Both carry the block's own
 * declaration, so the copy is told from anything else by that declaration: the
 * same action and the same own key, on an element of the same kind, under the
 * same block. A person's click at that point reaches the same control the step
 * named rather than something covering it.
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
 * Whether something else is drawn over the control at the point it occupies.
 *
 * Read from the document's own hit test, so it answers the question a person's
 * click would: the element that owns the point the control is drawn at. A
 * document with no hit test at all (jsdom) and a control with no box to test
 * (a hidden one, or layout the document does not compute) answer that there is
 * nothing to find rather than refusing every press — as does a point the hit
 * test reports no element for, which is one outside the rendered page.
 * @param target - the control a press is aimed at.
 * @returns whether it is covered.
 */
export function isCovered(target: Element): boolean {
  if (typeof document.elementFromPoint !== 'function') return false
  const rect = target.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return top !== null && !reaches(top, target)
}
