/**
 * The browser half of `act_component`: it runs one call's steps inside the
 * element the content column is drawing the named entry in.
 *
 * Every step is resolved inside that element and nowhere else. A control is
 * found by the key its component declares (`data-component-action`, or the
 * control's own key where one action is performed by several controls), a field
 * by the name the entry gives it (`data-component-field`, or the label,
 * placeholder or `name` a form control already carries), and both searches are
 * bounded by the block the step names — or by the whole entry when it names
 * none. That bound is the confine: a control the entry does not declare is a
 * step that names nothing, whatever else the console draws, and the reason says
 * only that it is not part of the entry rather than describing the user's
 * screen.
 *
 * Actions go through the block's own handlers: a press is a real `click()` on
 * the element, and a write goes through the prototype's value setter and then
 * dispatches `input` and `change`, which is what a React-controlled or Vue
 * component sees as a person typing. What a press checks before it dispatches
 * is whether the control is one a person could reach: a disabled control and
 * one something else is drawn over each stop the call, because the click would
 * otherwise reach a handler no real press could.
 *
 * The entry itself is read again before every step and the run stops where it
 * no longer matches the one the call was claimed against — the column replaces
 * what it draws without telling this seat, and the steps after a switch would
 * otherwise land in whatever entry took this one's place.
 *
 * Nothing here is copied from the page domain: a component entry has no ref
 * table, no frames and no cross-origin question, and no step of this tool ever
 * reaches one.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/act-executor
 */

import {
  DEFAULT_WAIT_MS,
  type ActComponentArgs,
  type ActComponentStep,
  type ActComponentStepResult,
} from '../act-component-call.ts'
import {
  actComponentReportText, ambiguousFieldReason, anotherEntryInFront, coveredReason, disabledReason,
  ENTRY_REDRAWN_REASON, missingTargetReason, NO_ENTRY_IN_FRONT, notWritableReason,
} from '../act-component-text.ts'
import type { DrawnEntry } from './entry-container.ts'

/** How often a `wait` step looks again. */
const WAIT_POLL_MS = 50

/** The controls a `set` step may write into. */
const WRITABLE = 'input, textarea, select'

/** The parts of a form control a `set` step may match a name against. */
const NAMED_BY = ['aria-label', 'name', 'placeholder'] as const

/**
 * The attribute an element carrying one action key is marked with.
 *
 * The attribute is read and the key compared in the page rather than turned
 * into a selector, for the reason {@link withAttribute} states.
 */
const ACTION_KEY = 'data-component-action'

/**
 * The attribute a control carrying its own key is marked with, for a component
 * whose one declared action is performed by several controls: a confirmation
 * bar's buttons each carry the bar's `press` action and their own id, and a
 * step naming the id presses that button while one naming the action presses
 * the first. Absent on controls that have no key of their own.
 */
const OWN_KEY = 'data-component-key'

/** The attribute naming the block an element is drawn by. */
const NODE_KEY = 'data-component-node'

/**
 * One element's own attribute value, compared exactly.
 * @param el - the element.
 * @param attribute - the attribute to read.
 * @param value - the value it must carry.
 * @returns whether it carries it.
 */
function marked(el: Element, attribute: string, value: string): boolean {
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
function withAttribute(root: Element, attribute: string): Element[] {
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
function scopeOf(entry: DrawnEntry, node: string | undefined): Element | undefined {
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
function clickTarget(scope: Element, key: string): Element | undefined {
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
function ownName(el: Element, within: Element): string {
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
function isDrawn(el: Element, within: Element): boolean {
  for (let node: Element | null = el; node !== within; node = node.parentElement) {
    /* v8 ignore next -- every candidate is inside the entry, so the walk reaches the container first */
    if (node === null) break
    if (node.hasAttribute('hidden')) return false
    const shown = getComputedStyle(node)
    if (shown.display === 'none' || shown.visibility === 'hidden') return false
  }
  return true
}

/** The roles a block draws a dialog or an overlay with, as the platform names them. */
const OVERLAY = '[role="dialog"], [aria-modal="true"]'

/**
 * The open dialog one field is drawn inside, when it is drawn inside one.
 * @param el - the field.
 * @param within - the entry's own container, past which nothing is asked.
 * @returns the dialog's element, or undefined when the field is not in an open one.
 */
function openDialog(el: Element, within: Element): Element | undefined {
  for (let node: Element | null = el.parentElement; node !== within; node = node.parentElement) {
    /* v8 ignore next -- every field is inside the entry, so the walk reaches the container first */
    if (node === null) break
    if (node.matches(OVERLAY) && isDrawn(node, within)) return node
  }
  return undefined
}

/**
 * The attribute a field is named with: the column or property a `set` step may
 * write. Read where a block declares its fields outright; a block that declares
 * none has its controls named by what they carry, for the reason
 * {@link ownName} states.
 */
const FIELD_KEY = 'data-component-field'

/**
 * Every control under one scope whose own accessible name is the one a step named.
 * @param scope - the subtree the step is confined to.
 * @param name - the column or property the step named.
 * @param within - the entry's own container, which bounds what may name a field.
 * @returns the controls, in document order.
 */
function namedControls(scope: Element, name: string, within: Element): Element[] {
  const controls = [...scope.querySelectorAll(WRITABLE)]
  if (scope.matches(WRITABLE)) controls.unshift(scope)
  return controls.filter(el => ownName(el, within) === name)
}

/**
 * The field one `set` step writes into.
 *
 * A block that names its fields declares them outright, and that declaration
 * wins; where it does not, the control whose own accessible name is the column
 * or property the step named is the one a person would type into, so it is the
 * one this writes.
 *
 * A block may draw one name more than once — a page keeps the write dialog it
 * closed in the document, under the same field names its query panel asks with
 * — and the field is then picked among the copies the way the person using the
 * page would: a copy inside an open dialog is the one asking for the value now
 * and wins over every other, and where no dialog is open the drawn copies are
 * the candidates. One drawn candidate is the field; several name one column or
 * property twice with nothing to say which is meant, and a step that guesses
 * would write where nobody asked.
 * @param scope - the subtree the step is confined to.
 * @param name - the column or property the step named.
 * @param within - the entry's own container, which bounds what may name a field.
 * @returns the control, or undefined when the subtree names none.
 * @throws {Error} when more than one drawn candidate remains for the name.
 */
function setTarget(scope: Element, name: string, within: Element): Element | undefined {
  const declared = withAttribute(scope, FIELD_KEY).filter(el => marked(el, FIELD_KEY, name))
  const candidates = declared.length > 0 ? declared : namedControls(scope, name, within)
  const inDialog = candidates.filter(el => openDialog(el, within) !== undefined)
  const chosen = inDialog.length > 0 ? inDialog : candidates.filter(el => isDrawn(el, within))
  if (chosen.length > 1) throw new Error(ambiguousFieldReason(name))
  return chosen[0] ?? candidates[0]
}

/**
 * Write one value into a form control the way a person typing would.
 *
 * The value is set through the prototype's own setter rather than by assigning
 * the element's property, because a controlled component replaces that property
 * with its own accessor and a plain assignment would reach the component's state
 * without its change handler ever seeing it.
 * @param el - the control to write into.
 * @param name - the column or property the step named, for the refusal.
 * @param value - what to write.
 * @throws {Error} when the control did not take the value.
 */
function writeValue(el: Element, name: string, value: string): void {
  if (el instanceof HTMLSelectElement) {
    el.value = value
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter === undefined) el.value = value
    else setter.call(el, value)
  }
  // Read back rather than assumed: a control that refused the value — a number
  // input and text it cannot hold — leaves this step failing instead of
  // reporting a write that never happened.
  if ((el as HTMLInputElement).value !== value) throw new Error(notWritableReason(name))
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Wait one turn before looking again. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Wait for one block or one declared control to be drawn.
 * @param entry - the drawn entry.
 * @param step - the wait step.
 * @returns whether it was there in time.
 */
async function waitFor(entry: DrawnEntry, step: ActComponentStep & { action: 'wait' }): Promise<boolean> {
  const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_MS
  const until = Date.now() + timeoutMs
  for (;;) {
    const scope = scopeOf(entry, step.node)
    if (scope !== undefined && (step.key === undefined || clickTarget(scope, step.key) !== undefined)) return true
    if (Date.now() >= until) return false
    await delay(Math.min(WAIT_POLL_MS, Math.max(until - Date.now(), 1)))
  }
}

/**
 * Run one step inside the entry.
 * @param entry - the drawn entry.
 * @param step - the step to run.
 * @throws {Error} with the model-facing reason when the step cannot run.
 */
async function runStep(entry: DrawnEntry, step: ActComponentStep): Promise<void> {
  if (step.action === 'wait') {
    if (!await waitFor(entry, step)) {
      throw new Error(missingTargetReason(`"${step.node ?? step.key}" did not appear in time`))
    }
    return
  }
  // Every search below is bounded by this scope, which is the entry's own
  // container or an element inside it: what the console draws beside the entry
  // is not reachable from here at all, so a control only it declares is a step
  // that names nothing rather than one that presses the wrong thing.
  // A scope that is missing is therefore always a named block the entry does
  // not draw: a step naming none searches the entry's own container.
  const scope = scopeOf(entry, step.node)
  if (scope === undefined) throw new Error(missingTargetReason(`block "${String(step.node)}"`))
  if (step.action === 'click') {
    const target = clickTarget(scope, step.key)
    if (target === undefined) throw new Error(missingTargetReason(`control "${step.key}"`))
    press(target, step.key)
    return
  }
  const target = setTarget(scope, step.name, entry.container)
  if (target === undefined) throw new Error(missingTargetReason(`field "${step.name}"`))
  writeValue(target, step.name, step.value)
}

/**
 * Whether a block has disabled one control.
 *
 * A block says so the two ways the platform does — the `disabled` attribute a
 * form control carries, and `aria-disabled` for anything else. A press of such
 * a control would be reported as one that ran while the block's own handler,
 * which a real browser never calls through a disabled control, never ran.
 * @param el - the control.
 * @returns whether it is disabled.
 */
function isDisabled(el: Element): boolean {
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
function isCovered(target: Element): boolean {
  if (typeof document.elementFromPoint !== 'function') return false
  const rect = target.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return top !== null && !reaches(top, target)
}

/**
 * Press one element the way a person would, so the block's own handler runs.
 *
 * An element with its own `click()` is pressed through it, which is what carries
 * the default action and the element's own activation behaviour; anything else —
 * an SVG control in a drawn chart — is given a bubbling click event instead.
 *
 * A control the block disabled, and one something else is drawn over, are
 * refusals rather than presses: the click this function would dispatch reaches
 * the block whether or not the control is reachable, so reporting the step as
 * one that ran would say a person could have done what they could not.
 * @param target - the element to press.
 * @param key - the action key the step named, for the refusal.
 * @throws {Error} when the control is disabled or covered.
 */
function press(target: Element, key: string): void {
  if (isDisabled(target)) throw new Error(disabledReason(key))
  if (isCovered(target)) throw new Error(coveredReason(key))
  if (target instanceof HTMLElement) {
    target.click()
    return
  }
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** What running one call's steps produced, before either half turns it into a report. */
export interface ActComponentRun {
  /** Whether every step ran or one of them stopped the call. */
  readonly status: 'done' | 'failed'
  /** One entry per requested step, in order. */
  readonly steps: readonly ActComponentStepResult[]
  /** What ran, and what the entry's own controls answered. */
  readonly text: string
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
 * Why the entry one step was about to run on is no longer the one in front.
 *
 * The column replaces what it draws without telling the seat, and one kind's
 * entries share the element they are drawn in — so a step that starts after a
 * switch would press a control of the entry that took this one's place while
 * the report kept naming the entry the call asked for. The entry is therefore
 * read again before every step, and the two facts the column writes about it
 * are compared: which entry the switcher marks as selected, and which element
 * the entry is drawn in. A redraw of the same entry in a new element is a
 * mismatch too: the steps would otherwise run in a subtree nobody sees.
 * @param entry - the entry the call resolved when it was claimed.
 * @param locate - how the console reads the entry in front now, the same reading the claim used.
 * @returns what stopped the call, or undefined while the entry is still the one in front.
 */
function displacedReason(entry: DrawnEntry, locate: () => DrawnEntry | undefined): string | undefined {
  const drawn = locate()
  if (drawn === undefined) return NO_ENTRY_IN_FRONT
  if (drawn.entryId !== entry.entryId) return anotherEntryInFront(drawn.entryId)
  if (drawn.container !== entry.container) return ENTRY_REDRAWN_REASON
  return undefined
}

/**
 * Run one call's steps against the entry the column is drawing.
 *
 * A failing step is a value rather than a rejection: it stops the call, the
 * steps after it are reported as not run, and the model reads which step
 * stopped it in the same answer that carries the rest.
 * @param args - the call's arguments.
 * @param entry - the entry the column is drawing, which the caller has matched to the call.
 * @param locate - reads the entry in front again, for the check before every step.
 * @returns what the call ended as.
 */
export async function runActComponent(
  args: ActComponentArgs,
  entry: DrawnEntry,
  locate: () => DrawnEntry | undefined,
): Promise<ActComponentRun> {
  const results: ActComponentStepResult[] = []
  let failed = false
  for (const [at, step] of args.steps.entries()) {
    if (failed) {
      results.push({ index: at + 1, status: 'skipped' })
      continue
    }
    try {
      const displaced = displacedReason(entry, locate)
      if (displaced !== undefined) throw new Error(displaced)
      await runStep(entry, step)
      results.push({ index: at + 1, status: 'ok' })
    } catch (refusal) {
      failed = true
      /* v8 ignore next -- the runner throws Error and nothing else; String() keeps a thrown non-Error readable */
      const message = refusal instanceof Error ? refusal.message : String(refusal)
      results.push({ index: at + 1, status: 'failed', message })
    }
  }
  const named = { id: entry.entryId, title: entry.title }
  return {
    status: failed ? 'failed' : 'done',
    steps: results,
    text: actComponentReportText(named, args.steps, results),
  }
}
