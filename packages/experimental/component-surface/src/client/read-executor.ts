/**
 * The browser half of `read_component`: it reads the entry the content column
 * is drawing, in the vocabulary the acting tool addresses it by.
 *
 * The reading answers the one question a call needs before it can act: what is
 * on screen right now, under which key. Every fact in it is read off the drawn
 * document through [the shared resolution](./targets.ts) a step runs through —
 * the same block bounds, the same declared action and own keys, the same field
 * names, the same question about whether a person could reach the control — so
 * a key the reading prints is a key a step would press, and neither half can
 * drift from the other.
 *
 * What it composes is a tree rather than a flat list of everything drawn: the
 * entry, one node per block, one nested node per open dialog, and the rows a
 * scope draws folded to a count, a counted set of the targets one row holds,
 * and the name of the first few. The fold is what keeps an answer about one
 * page of records an answer rather than a dump: a table draws its rows as
 * cells, one per column per record, and a reading that listed every one of them
 * spends its whole budget on data no step can name. A dialog is never folded:
 * it is where the next step almost always acts.
 *
 * What it describes is bounded to the entry the call named: the blocks the
 * placement drew inside it, the controls it declares, the fields it names, and
 * the dialogs it has open. Nothing outside that container is looked at, for the
 * reason the step executor states — what the console draws beside the entry is
 * the user's screen rather than this call's subject.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/read-executor
 */

import type {
  ComponentReadBlock, ComponentReadControl, ComponentReadDialog, ComponentReadField, ComponentReadRowDraw,
  ComponentReading, ComponentReadScope, ComponentReadRows, ComponentTargetState, ReadComponentArgs,
} from '../read-component-call.ts'
import { MAX_ROW_NAMES } from '../read-component-call.ts'
import { readComponentReportText } from '../read-component-text.ts'
import type { DrawnEntry } from './entry-container.ts'
import {
  ACTION_KEY, FIELD_KEY, NODE_KEY, OVERLAY, OWN_KEY, WRITABLE,
  isCovered, isDisabled, isDrawn, openDialog, ownName, pagerTotal, rowCopies, rowOf, scopeOf, withAttribute,
} from './targets.ts'

/** The kind each element is reported as, where the platform has no role to ask for one. */
const KINDS: Readonly<Record<string, string>> = {
  BUTTON: 'button',
  A: 'link',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  INPUT: 'textbox',
}

/** The headings a dialog's name may be drawn by. */
const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]'

/**
 * What one drawn element is, in the platform's own word for it.
 *
 * The element's own role wins wherever it declares one, because that is what
 * the console drew it as; otherwise the markup's own kind answers, with the
 * two input types that mean something other than a text box said as the
 * platform says them.
 * @param el - the element.
 * @returns the kind.
 */
function kindOf(el: Element): string {
  const role = el.getAttribute('role')
  if (role !== null && role !== '') return role
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return 'checkbox'
    if (el.type === 'radio') return 'radio'
  }
  return KINDS[el.tagName] ?? el.tagName.toLowerCase()
}

/**
 * What one drawn element says about itself.
 *
 * The words it draws come first, because that is what the user reads on the
 * screen; a control that draws none — a table's tick box, an icon button — is
 * named by what it carries instead, the same reading a `set` step takes when it
 * looks a field up by its own name.
 * @param el - the element.
 * @param within - the entry's own container, which bounds what may name it.
 * @returns its words, empty when it draws and carries none.
 */
function wordsOf(el: Element, within: Element): string {
  const drawn = drawnWords(el)
  return drawn === '' ? ownName(el, within) : drawn
}

/**
 * The words one drawn element carries in itself, trimmed.
 * @param el - the element.
 * @returns the words, empty where it draws none.
 */
function drawnWords(el: Element): string {
  /* v8 ignore next -- an element's textContent is null only for a document node, and this is an element */
  return (el.textContent ?? '').trim()
}

/**
 * How far a step naming one control or field would get.
 * @param el - the element.
 * @returns where it stands.
 */
function stateOf(el: Element): ComponentTargetState {
  if (isDisabled(el)) return 'disabled'
  if (isCovered(el)) return 'covered'
  return 'reachable'
}

/**
 * The block one element is drawn under, inside the entry.
 *
 * The walk reaches for the ids the reading reports rather than for the nearest
 * one: a block drawn inside another is reported as its own node when the
 * reading lists it, and a reading narrowed to one block that does not list the
 * inner node keeps its contents under the block the call asked for.
 * @param el - the element.
 * @param within - the entry's own container, past which nothing is asked.
 * @param listed - the block ids the reading reports.
 * @returns the block id, or undefined when no reported block drew it.
 */
function nodeOf(el: Element, within: Element, listed: ReadonlySet<string>): string | undefined {
  for (let node: Element | null = el; node !== null && node !== within; node = node.parentElement) {
    const id = node.getAttribute(NODE_KEY)
    if (id !== null && listed.has(id)) return id
  }
  return undefined
}

/**
 * The open dialog one element is drawn inside, when it is drawn inside one.
 *
 * The element is attributed to the outermost role around it: a component
 * library wraps a dialog in an overlay of its own — both carry the role — and
 * the reading reports the dialog the person sees rather than its wrapper.
 * @param el - the element.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the dialog's element, or undefined when the element is not drawn in one.
 */
function containingDialog(el: Element, within: Element): Element | undefined {
  let dialog = openDialog(el, within)
  if (dialog === undefined) return undefined
  let outer = openDialog(dialog, within)
  while (outer !== undefined) {
    dialog = outer
    outer = openDialog(dialog, within)
  }
  return dialog
}

/**
 * Whether one dialog is drawn inside another, which the reading reports as one
 * dialog rather than two: a component library wraps a dialog in an overlay of
 * its own, and both carry the role.
 * @param el - the dialog or overlay.
 * @param within - the entry's own container.
 * @returns whether an ancestor inside the entry is an overlay too.
 */
function insideOverlay(el: Element, within: Element): boolean {
  for (let node: Element | null = el.parentElement; node !== null && node !== within; node = node.parentElement) {
    if (node.matches(OVERLAY)) return true
  }
  return false
}

/**
 * The name one element declares for itself: the one it carries, then the one it
 * points at, then the first heading it draws.
 * @param el - the element.
 * @param within - the entry's own container, which bounds what may name it.
 * @returns the name, empty when it carries none.
 */
function declaredName(el: Element, within: Element): string {
  const label = el.getAttribute('aria-label')
  if (label !== null && label !== '') return label
  const described = el.getAttribute('aria-labelledby')
  if (described !== null && described !== '') {
    for (const named of within.querySelectorAll('[id]')) {
      if (named.getAttribute('id') !== described) continue
      /* v8 ignore next -- an element's textContent is null only for a document node, and this is an element */
      return (named.textContent ?? '').trim()
    }
  }
  const heading = el.querySelector(HEADINGS)
  return (heading?.textContent ?? '').trim()
}

/**
 * The name one open dialog draws for itself.
 *
 * A component library draws one dialog as two nested roles — an overlay of its
 * own around the dialog — and the name may be declared on either; the reading
 * reports what the innermost role that declares one says, so a dialog and the
 * controls drawn inside it are named the same way. A dialog that declares none
 * is reported as unnamed rather than by guessed words from its own body, which
 * would be the reading printing a form's contents back as a title.
 * @param dialog - the dialog's element, the outermost of its own group.
 * @param within - the entry's own container, which bounds what may name it.
 * @returns the name, empty when it draws none.
 */
function dialogName(dialog: Element, within: Element): string {
  const own = declaredName(dialog, within)
  if (own !== '') return own
  for (const nested of dialog.querySelectorAll(OVERLAY)) {
    const name = declaredName(nested, within)
    if (name !== '') return name
  }
  return ''
}

/**
 * The dialogs drawn in one subtree, outermost first.
 * @param scope - the subtree the reading is confined to.
 * @param within - the entry's own container.
 * @returns the dialogs, in document order.
 */
function openDialogs(scope: Element, within: Element): Element[] {
  return [...scope.querySelectorAll(OVERLAY)]
    .filter(el => isDrawn(el, within) && !insideOverlay(el, within))
}

/** One drawn target, paired with the element it was read off. */
interface DrawnTarget<T> {
  /** The element the target was read off. */
  readonly el: Element
  /** The target as the reading reports it. */
  readonly target: T
}

/**
 * Every marked control one subtree draws, in document order.
 * @param scope - the subtree the reading is confined to.
 * @param within - the entry's own container.
 * @returns the controls, paired with their elements.
 */
function controlsOf(scope: Element, within: Element): DrawnTarget<ComponentReadControl>[] {
  const marks = `[${ACTION_KEY}], [${OWN_KEY}]`
  const found = [...scope.querySelectorAll(marks)]
  if (scope.matches(marks)) found.unshift(scope)
  return found.filter(el => isDrawn(el, within)).map((el) => {
    const action = el.getAttribute(ACTION_KEY)
    const ownKey = el.getAttribute(OWN_KEY)
    return {
      el,
      target: {
        ...action === null ? {} : { action },
        ...ownKey === null ? {} : { ownKey },
        kind: kindOf(el),
        words: wordsOf(el, within),
        state: stateOf(el),
      },
    }
  })
}

/**
 * What one drawn field presently holds.
 *
 * A secret is reported as such rather than printed, because a reading is text
 * that reaches a model request and a password field's value is the user's. A
 * tick box holds a state rather than a value, and is reported as the platform
 * draws it. Everything else is its own `value`, which is what a `set` step
 * would replace.
 * @param el - the field's control.
 * @returns the value, tick or secret it carries, none of them where it carries none.
 */
function heldBy(el: Element): Pick<ComponentReadField, 'value' | 'checked' | 'secret'> {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return { secret: true }
    if (el.type === 'checkbox' || el.type === 'radio') return { checked: el.checked }
    return { value: el.value }
  }
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return { value: el.value }
  return {}
}

/**
 * Every field one subtree names, in document order.
 *
 * Two ways name one, the same two a `set` step looks by: the block's own
 * declaration, and — where it declares none — the control's own accessible
 * name. A control that carries neither is not a field any step could write, so
 * the reading does not list it.
 * @param scope - the subtree the reading is confined to.
 * @param within - the entry's own container.
 * @returns the fields, paired with their elements.
 */
function fieldsOf(scope: Element, within: Element): DrawnTarget<ComponentReadField>[] {
  const named = `[${FIELD_KEY}], ${WRITABLE}`
  const found = [...scope.querySelectorAll(named)]
  if (scope.matches(named)) found.unshift(scope)
  const fields: DrawnTarget<ComponentReadField>[] = []
  for (const el of found) {
    const declared = el.getAttribute(FIELD_KEY)
    const name = declared ?? ownName(el, within)
    if (name === '' || !isDrawn(el, within)) continue
    fields.push({ el, target: { name, kind: kindOf(el), ...heldBy(el), state: stateOf(el) } })
  }
  return fields
}

/**
 * What one drawn row is called: the words of its first drawn target that draws
 * any, so a model reads a record's own name rather than an index.
 * @param copies - the row's drawn copies, first drawn first.
 * @param within - the entry's own container.
 * @returns the name, empty where the row draws no words at all.
 */
function rowName(copies: readonly Element[], within: Element): string {
  for (const copy of copies) {
    const named = [...copy.querySelectorAll(`[${ACTION_KEY}], [${OWN_KEY}], [${FIELD_KEY}], ${WRITABLE}`)]
      .filter(el => isDrawn(el, within))
      .map(el => drawnWords(el))
      .find(words => words !== '')
    if (named !== undefined) return named
  }
  return ''
}

/**
 * The kinds of target one drawn row holds, counted by key rather than listed by cell.
 *
 * Two controls of a row are one kind when a step naming either would address
 * the same key of the same kind — a table's cell-click column is one such kind
 * drawn once per record — and what differs between them is the data they draw,
 * which is what the row's own name stands for.
 * @param copies - the row's drawn copies, first drawn first.
 * @param within - the entry's own container.
 * @returns the kinds, in the order the row draws them.
 */
function rowDraws(copies: readonly Element[], within: Element): ComponentReadRowDraw[] {
  const counted = new Map<string, ComponentReadRowDraw>()
  for (const copy of copies) {
    for (const { target } of controlsOf(copy, within)) {
      const key = `${target.action ?? ''}\u0000${target.ownKey ?? ''}\u0000${target.kind}`
      const same = counted.get(key)
      counted.set(key, {
        ...target.action === undefined ? {} : { action: target.action },
        ...target.ownKey === undefined ? {} : { ownKey: target.ownKey },
        kind: target.kind,
        count: (same?.count ?? 0) + 1,
      })
    }
  }
  return [...counted.values()]
}

/**
 * The rows one scope draws, folded.
 *
 * The rows are read off the targets the scope draws itself — the same drawn
 * controls and fields a step resolves — so a row the reading counts is one a
 * step naming a key inside it would reach, and the name a row carries is its
 * own first drawn words. The page's own count of the records its query
 * matched, where it draws one, is the words the page shows rather than a number
 * parsed out of them.
 * @param scope - the scope's own element, which is where the pager is read.
 * @param targets - the elements the scope draws outside its dialogs.
 * @param within - the entry's own container.
 * @returns the folded rows, or undefined where the scope draws none.
 */
function rowsOf(scope: Element, targets: readonly Element[], within: Element): ComponentReadRows | undefined {
  const rows = targets.map(el => rowOf(el, within)).filter((row): row is Element => row !== undefined)
  if (rows.length === 0) return undefined
  const merged = rowCopies([...new Set(rows)])
  const total = pagerTotal(scope)
  return {
    drawn: merged.length,
    named: merged.slice(0, MAX_ROW_NAMES).map(copies => ({
      name: rowName(copies, within),
      draws: rowDraws(copies, within),
    })),
    ...total === undefined ? {} : { total },
  }
}

/**
 * Read one scope's own contents: the targets it draws itself, its folded rows,
 * and nothing of the dialogs open inside it.
 *
 * An element is the scope's own when the block it is drawn under is the one
 * being read — the block itself, or no block at all for the entry's own
 * outside scope — which keeps a block drawn inside another from being read
 * twice, and keeps a reading narrowed to one block from losing the contents of
 * a node the call did not name.
 * @param scope - the scope's own element.
 * @param within - the entry's own container.
 * @param listed - the block ids the reading reports.
 * @param node - the block this scope reads, absent for the entry's outside scope.
 * @returns the scope's controls, fields and folded rows.
 */
function scopeDrawn(scope: Element, within: Element, listed: ReadonlySet<string>, node: string | undefined): ComponentReadScope {
  const own = (el: Element): boolean => nodeOf(el, within, listed) === node
  const drawn = (el: Element): boolean => own(el) && containingDialog(el, within) === undefined
  const controls = controlsOf(scope, within).filter(entry => drawn(entry.el))
  const fields = fieldsOf(scope, within).filter(entry => drawn(entry.el))
  // The fold is over the scope's controls: a field drawn in a row is a target
  // a `set` step names, and it keeps its own line with the value it holds.
  const rows = rowsOf(scope, controls.map(entry => entry.el), within)
  return {
    // A control drawn in a row is reported by the fold rather than on a line
    // of its own: one line per cell is the listing this reading exists not to
    // be, and the row's own name is what the cell's data says.
    controls: controls.filter(entry => rowOf(entry.el, within) === undefined).map(entry => entry.target),
    fields: fields.map(entry => entry.target),
    ...rows === undefined ? {} : { rows },
  }
}

/**
 * Read one open dialog, as a node of the tree.
 *
 * Everything drawn inside the dialog is the dialog's: a component library wraps
 * it in a role of its own, and a second dialog drawn inside it is one the
 * person sees as the same dialog, so neither is read apart from it.
 * @param dialog - the dialog's own element, the outermost of its group.
 * @param within - the entry's own container.
 * @param node - the block the dialog stands in, absent for one outside every block.
 * @returns the dialog.
 */
function dialogOf(dialog: Element, within: Element, node: string | undefined): ComponentReadDialog {
  const controls = controlsOf(dialog, within)
  const fields = fieldsOf(dialog, within)
  const rows = rowsOf(dialog, controls.map(entry => entry.el), within)
  return {
    name: dialogName(dialog, within),
    ...node === undefined ? {} : { node },
    // As in a block: a control the dialog draws in a row of its own is folded
    // into that row rather than listed beside it.
    controls: controls.filter(entry => rowOf(entry.el, within) === undefined).map(entry => entry.target),
    fields: fields.map(entry => entry.target),
    ...rows === undefined ? {} : { rows },
  }
}

/**
 * The dialogs open in one scope, each attributed to the block it is drawn in.
 * @param scope - the scope's own element.
 * @param within - the entry's own container.
 * @param listed - the block ids the reading reports.
 * @param node - the block to attribute the dialogs to, absent for the reading of a whole entry.
 * @returns the dialogs, in document order.
 */
function dialogsOf(
  scope: Element,
  within: Element,
  listed: ReadonlySet<string>,
  node: string | undefined,
): ComponentReadDialog[] {
  return openDialogs(scope, within)
    .filter(dialog => nodeOf(dialog, within, listed) === node)
    .map(dialog => dialogOf(dialog, within, node))
}

/**
 * Read one call's entry, as the console sees it now.
 *
 * A block the call narrows the reading to and the entry does not draw is no
 * rejection: the reading reports the blocks that are drawn and the sentence
 * saying the named one is not among them, which is what a model needs to name
 * a block that exists.
 * @param args - the call's arguments.
 * @param entry - the entry the column is drawing, which the caller has matched to the call.
 * @returns the reading, as the text the report carries.
 */
export function readComponent(args: ReadComponentArgs, entry: DrawnEntry): string {
  return readComponentReportText(readingOf(args, entry))
}

/**
 * The node ids of the blocks the entry draws, in document order, each once.
 * @param within - the entry's own container.
 * @returns the ids.
 */
function blockIds(within: Element): string[] {
  const ids: string[] = []
  for (const el of withAttribute(within, NODE_KEY)) {
    if (!isDrawn(el, within)) continue
    /* v8 ignore next -- the element was read out of that attribute, so it carries a value for it */
    ids.push(el.getAttribute(NODE_KEY) ?? '')
  }
  return [...new Set(ids)]
}

/**
 * What one call's entry shows right now, before the text module writes it out.
 * @param args - the call's arguments.
 * @param entry - the entry the column is drawing, which the caller has matched to the call.
 * @returns what the reading found, as the tree the text module writes out.
 */
function readingOf(args: ReadComponentArgs, entry: DrawnEntry): ComponentReading {
  const within = entry.container
  const named = { id: entry.entryId, title: entry.title }
  const ids = blockIds(within)
  if (args.node !== undefined) {
    const scope = scopeOf(entry, args.node)
    if (scope === undefined) {
      // The dialogs are still the entry's, wherever they are drawn: the call
      // named a block this entry does not draw, and what a model acts on next
      // may be what is already open in front.
      const open = new Set(ids)
      return {
        entry: named,
        blockIds: ids,
        blocks: [],
        outside: {
          controls: [],
          fields: [],
          dialogs: openDialogs(within, within).map(dialog => dialogOf(dialog, within, nodeOf(dialog, within, open))),
        },
        missingNode: args.node,
      }
    }
    const listed = new Set([args.node])
    return {
      entry: named,
      blockIds: ids,
      blocks: [toBlock(args.node, scope, within, listed)],
      outside: { controls: [], fields: [], dialogs: [] },
    }
  }
  const listed = new Set(ids)
  return {
    entry: named,
    blockIds: ids,
    blocks: ids.map((node) => {
      const element = withAttribute(within, NODE_KEY).find(el => el.getAttribute(NODE_KEY) === node && isDrawn(el, within))
      /* v8 ignore next -- the id came off a drawn element inside this container */
      if (element === undefined) return { node, controls: [], fields: [], dialogs: [] }
      return toBlock(node, element, within, listed)
    }),
    outside: { ...scopeDrawn(within, within, listed, undefined), dialogs: dialogsOf(within, within, listed, undefined) },
  }
}

/**
 * One block read as its own node: what it draws itself, and the dialogs open inside it.
 * @param node - the block's id.
 * @param element - the block's own element.
 * @param within - the entry's own container.
 * @param listed - the block ids the reading reports.
 * @returns the block node.
 */
function toBlock(node: string, element: Element, within: Element, listed: ReadonlySet<string>): ComponentReadBlock {
  return {
    node,
    ...scopeDrawn(element, within, listed, node),
    dialogs: dialogsOf(element, within, listed, node),
  }
}
