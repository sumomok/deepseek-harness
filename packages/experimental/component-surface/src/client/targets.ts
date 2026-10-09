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

/** The element-ui select one field control is drawn inside, which is what makes the field a select. */
export const SELECT = '.el-select'

/** One select's drawn options, a child of the select itself since this row contains its list. */
export const SELECT_OPTION = '.el-select-dropdown__item'

/** The input element-ui draws one select's own text in. */
export const SELECT_INPUT = 'input.el-input__inner'

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
 * @param scope - the subtree the step is confined to.
 * @param key - the action key, or the control's own key, the step names.
 * @returns the element, or undefined when nothing in the subtree declares it.
 */
export function clickTarget(scope: Element, key: string): Element | undefined {
  for (const attribute of [ACTION_KEY, OWN_KEY]) {
    const found = withAttribute(scope, attribute).find(el => marked(el, attribute, key))
    if (found !== undefined) return found
  }
  return undefined
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
