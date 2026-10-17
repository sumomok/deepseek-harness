/**
 * The targets one call resolves inside one drawn entry: the block it is
 * confined to, the control a key names, the field a name addresses, and whether
 * a person could reach either.
 *
 * Every search is bounded by a subtree of the entry's own container, and every
 * key or name is the block's own declaration (`data-component-action`,
 * `data-component-key`, `data-component-field`, `data-component-node`,
 * `data-component-row`), so a control the entry does not declare names
 * nothing. The step executor and the reader both resolve through this module,
 * so a control a reading describes is the element a step naming it reaches.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/targets
 */

import { isTarget, type ActComponentClick } from '../act-component-call.ts'
import type { ControlRows, ControlSpread } from '../act-component-text.ts'
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
 * the own key presses that control, and a step naming the shared action is
 * refused while more than one of those controls is drawn.
 */
export const OWN_KEY = 'data-component-key'

/** The attribute naming the block an element is drawn by. */
export const NODE_KEY = 'data-component-node'

/**
 * The attribute naming the row one control is drawn in, by the key the
 * component gives that row: written on the control or on an ancestor inside
 * the entry, and read off the nearest one. Which value a row carries is the
 * component's own choice; this module only compares it.
 */
export const ROW_KEY = 'data-component-row'

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

/** What one `click` step's key and row resolve to inside the subtree it is confined to. */
export type ClickTarget =
  | {
    /** Exactly one drawn control carries the key in the row the step named, if it named one. */
    readonly kind: 'one'
    /** That control. */
    readonly target: Element
  }
  | {
    /** No drawn control carries the key. */
    readonly kind: 'none'
  }
  | {
    /** Drawn controls carry the key, and nothing drawn in the scope carries the row the step named. */
    readonly kind: 'row-not-drawn'
    /** The row the step named. */
    readonly row: string
  }
  | {
    /** The row the step named is drawn, and none of the controls carrying the key is drawn in it. */
    readonly kind: 'not-in-row'
    /** The row the step named. */
    readonly row: string
  }
  | {
    /** Several drawn controls carry the key where the step looked. */
    readonly kind: 'several'
    /** Whether they declare it as their action or carry it as their own key. */
    readonly by: 'action' | 'own-key'
    /** How many. */
    readonly count: number
    /** The blocks they are drawn in; absent where no `node` would look at fewer of them. */
    readonly spread: ControlSpread | undefined
    /**
     * The rows they are drawn in; absent where the step named a row, or where
     * no `row` would look at fewer of them.
     */
    readonly rows: ControlRows | undefined
    /**
     * Each one's own key, in document order, for controls declaring the key as
     * their action where every one carries an own key a step can name and no
     * two carry the same; absent otherwise.
     */
    readonly ownKeys: readonly string[] | undefined
  }

/**
 * Every drawn ({@link isDrawn}) control of one subtree carrying one value under one attribute.
 * @param scope - the subtree to search.
 * @param attribute - {@link ACTION_KEY} or {@link OWN_KEY}.
 * @param key - the value the control carries there.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the controls, in document order.
 */
function drawnCarrying(scope: Element, attribute: string, key: string, within: Element): Element[] {
  return withAttribute(scope, attribute).filter(el => marked(el, attribute, key) && isDrawn(el, within))
}

/**
 * The own keys that tell several controls apart.
 * @param controls - the controls one action key names.
 * @returns each one's own key in document order, or undefined when one of them
 *   carries none a step can name or two carry the same.
 */
function distinctOwnKeys(controls: readonly Element[]): string[] | undefined {
  const keys = controls.map(el => el.getAttribute(OWN_KEY))
  if (!keys.every(isTarget)) return undefined
  return new Set(keys).size === keys.length ? keys : undefined
}

/**
 * The value one element's nearest carrier of an attribute holds, itself
 * included, walking up to the entry's own container.
 * @param el - the element.
 * @param within - the entry's own container, past which nothing is asked.
 * @param attribute - the attribute to look for.
 * @returns the value, or undefined where nothing inside the entry carries it.
 */
function nearest(el: Element, within: Element, attribute: string): string | undefined {
  for (let node: Element | null = el; node !== null && node !== within; node = node.parentElement) {
    const value = node.getAttribute(attribute)
    if (value !== null) return value
  }
  return undefined
}

/**
 * The block one element is drawn in: the id its nearest {@link NODE_KEY}
 * element inside the entry carries.
 * @param el - the element.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the block id, or undefined where no block inside the entry holds it.
 */
function blockOf(el: Element, within: Element): string | undefined {
  return nearest(el, within, NODE_KEY)
}

/**
 * The row one element is drawn in: the key its nearest {@link ROW_KEY}
 * element inside the entry carries.
 * @param el - the element.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the row key, or undefined where no row inside the entry holds it.
 */
export function rowKeyOf(el: Element, within: Element): string | undefined {
  return nearest(el, within, ROW_KEY)
}

/**
 * Group several controls by one reading of where each stands, in document order.
 * @param controls - the controls.
 * @param groupOf - where one control stands; undefined for the group of controls that stand nowhere.
 * @returns the controls by group, first seen first.
 */
function groupBy(controls: readonly Element[], groupOf: (el: Element) => string | undefined): Map<string | undefined, Element[]> {
  const groups = new Map<string | undefined, Element[]>()
  for (const el of controls) {
    const group = groupOf(el)
    const held = groups.get(group)
    if (held === undefined) groups.set(group, [el])
    else held.push(el)
  }
  return groups
}

/**
 * The blocks several controls are drawn in, each control's {@link blockOf},
 * where a step naming one of them would look at fewer.
 * @param controls - the controls one key names where the step looked.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the spread, or undefined where the controls stand in one group —
 *   one block, or outside every block — or where no group is a block a step
 *   could name.
 */
function spreadOf(controls: readonly Element[], within: Element): ControlSpread | undefined {
  const groups = groupBy(controls, el => blockOf(el, within))
  const blocks = [...groups.keys()].filter(isTarget)
  if (groups.size < 2 || blocks.length === 0) return undefined
  const unnamed = [...groups].filter(([id]) => id !== undefined && !isTarget(id))
  return {
    blocks,
    outside: groups.get(undefined)?.length ?? 0,
    unnamed: unnamed.reduce((sum, [, held]) => sum + held.length, 0),
    unnamedBlocks: unnamed.length,
  }
}

/**
 * The rows several controls are drawn in, each control's {@link rowKeyOf},
 * where a step naming one of them would look at fewer.
 * @param controls - the controls one key names where the step looked.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the rows, or undefined where the controls stand in one group — one
 *   row, or no row a step could name — or where no row is one a step could name.
 */
function rowsOf(controls: readonly Element[], within: Element): ControlRows | undefined {
  const groups = groupBy(controls, (el) => {
    const key = rowKeyOf(el, within)
    return isTarget(key) ? key : undefined
  })
  const keys = [...groups.keys()].filter(isTarget)
  if (groups.size < 2 || keys.length === 0) return undefined
  const crowdedRows = keys.map(key => groups.get(key) as Element[]).filter(held => held.length > 1)
  const crowded = crowdedRows.length === 0
    ? 'none'
    : crowdedRows.every(held => distinctOwnKeys(held) !== undefined) ? 'told-apart' : 'not-told-apart'
  return { keys, crowded, rowless: groups.get(undefined)?.length ?? 0 }
}

/**
 * The controls a step naming one block means among several it reaches: those
 * the block draws itself win over those of a block drawn inside it, which a
 * step names by that block's own id.
 * @param controls - the drawn controls carrying the key inside the scope.
 * @param node - the block the step named, absent for the whole entry.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the block's own controls where it draws any and also holds others, the controls otherwise.
 */
function ownControls(controls: readonly Element[], node: string | undefined, within: Element): readonly Element[] {
  if (node === undefined || controls.length < 2) return controls
  const own = controls.filter(el => blockOf(el, within) === node)
  return own.length === 0 ? controls : own
}

/**
 * Whether one row is drawn in a subtree: an element carrying its key there
 * that a person could see.
 * @param scope - the subtree the step is confined to.
 * @param row - the row key the step named.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns whether it is drawn.
 */
function rowDrawn(scope: Element, row: string, within: Element): boolean {
  return withAttribute(scope, ROW_KEY).some(el => marked(el, ROW_KEY, row) && isDrawn(el, within))
}

/**
 * The control one `click` step presses: the one drawn ({@link isDrawn})
 * control carrying the key as its declared action ({@link ACTION_KEY}), else
 * the one carrying it as its own key ({@link OWN_KEY}), kept to the row the
 * step names ({@link ROW_KEY}) where it names one. A block keeps closed
 * controls — a row's confirmation bubble, a closed dialog — in the document,
 * and a press must land where a person's could, so undrawn candidates are
 * passed over. A step naming a block means the controls that block draws
 * itself before those of a block drawn inside it. Where several drawn controls
 * remain, the step does not say which one it means and nothing is pressed; the
 * answer says how many there are and which blocks, rows or own keys would name
 * each one.
 * @param scope - the subtree the step is confined to.
 * @param step - the click step: its key, and the block and row it names.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns what the key names among the drawn controls.
 */
export function clickTarget(scope: Element, step: ActComponentClick, within: Element): ClickTarget {
  const byAction = drawnCarrying(scope, ACTION_KEY, step.key, within)
  const by = byAction.length > 0 ? 'action' : 'own-key'
  const carrying = byAction.length > 0 ? byAction : drawnCarrying(scope, OWN_KEY, step.key, within)
  if (carrying.length === 0) return { kind: 'none' }
  const { row } = step
  let inRow: readonly Element[] = carrying
  if (row !== undefined) {
    inRow = carrying.filter(el => rowKeyOf(el, within) === row)
    if (inRow.length === 0) return { kind: rowDrawn(scope, row, within) ? 'not-in-row' : 'row-not-drawn', row }
  }
  const candidates = ownControls(inRow, step.node, within)
  const [only] = candidates
  if (candidates.length === 1 && only !== undefined) return { kind: 'one', target: only }
  return {
    kind: 'several',
    by,
    count: candidates.length,
    spread: spreadOf(candidates, within),
    rows: row === undefined ? rowsOf(candidates, within) : undefined,
    ownKeys: by === 'action' ? distinctOwnKeys(candidates) : undefined,
  }
}

/**
 * Whether one subtree draws any control carrying the key, as its declared
 * action or as its own key: what a `wait` step waits for, which any one drawn
 * control satisfies.
 * @param scope - the subtree the step is confined to.
 * @param key - the action key, or the control's own key, the step names.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns whether a drawn control carries it.
 */
export function drawsKey(scope: Element, key: string, within: Element): boolean {
  return [ACTION_KEY, OWN_KEY].some(attribute => drawnCarrying(scope, attribute, key, within).length > 0)
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
 * Whether one autocomplete's list holds its asking row. Read off the subtree
 * rather than through {@link isDrawn}: element-ui keeps the row in a panel it
 * hid, because a Tab keydown closes the panel without taking the row away.
 * @param autocomplete - the autocomplete element.
 * @returns whether the row is there.
 */
export function askingRowPresent(autocomplete: Element): boolean {
  return autocomplete.querySelector(`${AUTOCOMPLETE_OPTION} ${LOADING_ICON}`) !== null
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
