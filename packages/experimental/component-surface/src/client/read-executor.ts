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
 * What it describes is bounded to the entry the call named: the blocks the
 * placement drew inside it, the controls it declares, the fields it names, and
 * the dialogs it has open. Nothing outside that container is looked at, for the
 * reason the step executor states — what the console draws beside the entry is
 * the user's screen rather than this call's subject.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/read-executor
 */

import type {
  ComponentReadControl, ComponentReadField, ComponentReading, ComponentTargetState, ReadComponentArgs,
} from '../read-component-call.ts'
import { readComponentReportText } from '../read-component-text.ts'
import type { DrawnEntry } from './entry-container.ts'
import {
  ACTION_KEY, FIELD_KEY, NODE_KEY, OVERLAY, OWN_KEY, WRITABLE,
  isCovered, isDisabled, isDrawn, openDialog, ownName, scopeOf, withAttribute,
} from './targets.ts'

/** The kind each element is reported as, where the platform has no role to ask for one. */
const KINDS: Readonly<Record<string, string>> = {
  BUTTON: 'button',
  A: 'link',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  INPUT: 'textbox',
}

/** How many characters of a dialog's own first heading the reading asks for. */
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
  /* v8 ignore next -- an element's textContent is null only for a document node, and this is an element */
  const drawn = (el.textContent ?? '').trim()
  return drawn === '' ? ownName(el, within) : drawn
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
 * The block one element was drawn under, inside the entry.
 * @param el - the element.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the block id, or undefined when no block inside the entry drew it.
 */
function nodeOf(el: Element, within: Element): string | undefined {
  for (let node: Element | null = el; node !== null && node !== within; node = node.parentElement) {
    const id = node.getAttribute(NODE_KEY)
    if (id !== null) return id
  }
  return undefined
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
 * The dialogs the entry has open, outermost first.
 * @param within - the entry's own container.
 * @returns the dialogs, in document order.
 */
function openDialogs(within: Element): Element[] {
  return [...within.querySelectorAll(OVERLAY)]
    .filter(el => isDrawn(el, within) && !insideOverlay(el, within))
}

/**
 * Every marked control the entry draws, in document order.
 * @param scope - the subtree the reading is confined to.
 * @param within - the entry's own container.
 * @returns the controls.
 */
function controlsOf(scope: Element, within: Element): ComponentReadControl[] {
  const marked = `[${ACTION_KEY}], [${OWN_KEY}]`
  const found = [...scope.querySelectorAll(marked)]
  if (scope.matches(marked)) found.unshift(scope)
  return found.filter(el => isDrawn(el, within)).map((el) => {
    const action = el.getAttribute(ACTION_KEY)
    const ownKey = el.getAttribute(OWN_KEY)
    const node = nodeOf(el, within)
    const dialog = openDialog(el, within)
    return {
      ...action === null ? {} : { action },
      ...ownKey === null ? {} : { ownKey },
      kind: kindOf(el),
      words: wordsOf(el, within),
      state: stateOf(el),
      ...node === undefined ? {} : { node },
      ...dialog === undefined ? {} : { dialog: dialogName(dialog, within) },
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
 * Every field the entry names for the subtree the reading is confined to, in
 * document order.
 *
 * Two ways name one, the same two a `set` step looks by: the block's own
 * declaration, and — where it declares none — the control's own accessible
 * name. A control that carries neither is not a field any step could write, so
 * the reading does not list it.
 * @param scope - the subtree the reading is confined to.
 * @param within - the entry's own container.
 * @returns the fields.
 */
function fieldsOf(scope: Element, within: Element): ComponentReadField[] {
  const named = `[${FIELD_KEY}], ${WRITABLE}`
  const found = [...scope.querySelectorAll(named)]
  if (scope.matches(named)) found.unshift(scope)
  const fields: ComponentReadField[] = []
  for (const el of found) {
    const declared = el.getAttribute(FIELD_KEY)
    const name = declared ?? ownName(el, within)
    if (name === '' || !isDrawn(el, within)) continue
    const node = nodeOf(el, within)
    const dialog = openDialog(el, within)
    fields.push({
      name,
      kind: kindOf(el),
      ...heldBy(el),
      state: stateOf(el),
      ...node === undefined ? {} : { node },
      ...dialog === undefined ? {} : { dialog: dialogName(dialog, within) },
    })
  }
  return fields
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
 * @returns what the reading found.
 */
function readingOf(args: ReadComponentArgs, entry: DrawnEntry): ComponentReading {
  const within = entry.container
  const named = { id: entry.entryId, title: entry.title }
  const blocks = blockIds(within)
  const drawn = openDialogs(within).map(dialog => dialogName(dialog, within))
  const scope = args.node === undefined ? undefined : scopeOf(entry, args.node)
  if (args.node !== undefined && scope === undefined) {
    return { entry: named, blocks, missingNode: args.node, controls: [], fields: [], dialogs: drawn }
  }
  const read = scope ?? within
  return {
    entry: named,
    blocks,
    controls: controlsOf(read, within),
    fields: fieldsOf(read, within),
    dialogs: scope === undefined ? drawn : openDialogs(scope).map(dialog => dialogName(dialog, within)),
  }
}
