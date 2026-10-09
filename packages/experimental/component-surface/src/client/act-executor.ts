/**
 * The browser half of `act_component`: it runs one call's steps inside the
 * element the content column is drawing the named entry in.
 *
 * Every step is resolved inside that element and nowhere else. A control is
 * found by the key its component declares (`data-component-action`), a field by
 * the name the entry gives it (`data-component-field`, or the label, placeholder
 * or `name` a form control already carries), and both searches are bounded by
 * the block the step names — or by the whole entry when it names none. That
 * bound is the confine: a control the entry does not declare is a step that
 * names nothing, whatever else the console draws, and the reason says only that
 * it is not part of the entry rather than describing the user's screen.
 *
 * Actions go through the block's own handlers: a press is a real `click()` on
 * the element, and a write goes through the prototype's value setter and then
 * dispatches `input` and `change`, which is what a React-controlled or Vue
 * component sees as a person typing.
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
import { actComponentReportText, missingTargetReason, notWritableReason } from '../act-component-text.ts'
import type { DrawnEntry } from './entry-container.ts'

/** How often a `wait` step looks again. */
const WAIT_POLL_MS = 50

/** The controls a `set` step may write into. */
const WRITABLE = 'input, textarea, select'

/** The parts of a form control a `set` step may match a name against. */
const NAMED_BY = ['aria-label', 'name', 'placeholder'] as const

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
  const found = withAttribute(entry.container, 'data-component-node').find(el => marked(el, 'data-component-node', node))
  return found === undefined ? undefined : found
}

/**
 * The control one `click` step presses.
 * @param scope - the subtree the step is confined to.
 * @param key - the action key the component declares for it.
 * @returns the element, or undefined when nothing in the subtree declares it.
 */
function clickTarget(scope: Element, key: string): Element | undefined {
  return withAttribute(scope, 'data-component-action').find(el => marked(el, 'data-component-action', key))
}

/**
 * Where one form control's own name is written.
 *
 * The label is looked up inside the entry as well: a `for` pointing outside it
 * would otherwise let the console's own words decide which field a call writes,
 * and this step's whole confine is that one entry. Ids are the entry's own
 * tokens, so the selector carries no escaping question.
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
  return (within.querySelector(`label[for="${id}"]`)?.textContent ?? '').trim()
}

/**
 * The field one `set` step writes into.
 *
 * A block that names its fields declares them outright, and that declaration
 * wins; where it does not, the control whose own accessible name is the column
 * or property the step named is the one a person would type into, so it is the
 * one this writes.
 * @param scope - the subtree the step is confined to.
 * @param name - the column or property the step named.
 * @param within - the entry's own container, which bounds what may name a field.
 * @returns the control, or undefined when the subtree names none.
 */
function setTarget(scope: Element, name: string, within: Element): Element | undefined {
  const declared = withAttribute(scope, 'data-component-field').find(el => marked(el, 'data-component-field', name))
  if (declared !== undefined) return declared
  const controls = [...scope.querySelectorAll(WRITABLE)]
  if (scope.matches(WRITABLE)) controls.unshift(scope)
  return controls.find(el => ownName(el, within) === name)
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
    press(target)
    return
  }
  const target = setTarget(scope, step.name, entry.container)
  if (target === undefined) throw new Error(missingTargetReason(`field "${step.name}"`))
  writeValue(target, step.name, step.value)
}

/**
 * Press one element the way a person would, so the block's own handler runs.
 *
 * An element with its own `click()` is pressed through it, which is what carries
 * the default action and the element's own activation behaviour; anything else —
 * an SVG control in a drawn chart — is given a bubbling click event instead.
 * @param target - the element to press.
 */
function press(target: Element): void {
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
 * Run one call's steps against the entry the column is drawing.
 *
 * A failing step is a value rather than a rejection: it stops the call, the
 * steps after it are reported as not run, and the model reads which step
 * stopped it in the same answer that carries the rest.
 * @param args - the call's arguments.
 * @param entry - the entry the column is drawing, which the caller has matched to the call.
 * @returns what the call ended as.
 */
export async function runActComponent(args: ActComponentArgs, entry: DrawnEntry): Promise<ActComponentRun> {
  const results: ActComponentStepResult[] = []
  let failed = false
  for (const [at, step] of args.steps.entries()) {
    if (failed) {
      results.push({ index: at + 1, status: 'skipped' })
      continue
    }
    try {
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
