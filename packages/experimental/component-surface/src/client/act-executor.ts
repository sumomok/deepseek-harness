/**
 * The browser half of `act_component`: it runs one call's steps inside the
 * element the content column is drawing the named entry in.
 *
 * Every target is resolved inside that element and nowhere else, through
 * [the shared resolution](./targets.ts): a control by the key its component
 * declares, a field by the name the entry gives it, and both bounded by the
 * block the step names — or by the whole entry when it names none. That bound
 * is the confine: a control the entry does not declare is a step that names
 * nothing, whatever else the console draws, and the reason says only that it is
 * not part of the entry rather than describing the user's screen.
 *
 * Actions go through the block's own handlers: a press is a real `click()` on
 * the element, and a write goes through the prototype's value setter and then
 * dispatches `input` and `change`, which is what a React-controlled or Vue
 * component sees as a person typing. A select field is filled the way a person
 * chooses instead: the list is opened, one option whose label is the value is
 * clicked, and the step is done only once the select displays it. What a press
 * checks before it dispatches is whether the control is one a person could
 * reach: a disabled control and one something else is drawn over each stop the
 * call, because the click would otherwise reach a handler no real press could.
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
  actComponentReportText, ambiguousFieldReason, ambiguousOptionReason, anotherEntryInFront, coveredReason,
  disabledFieldReason, disabledReason, ENTRY_REDRAWN_REASON, missingTargetReason, noOptionReason,
  NO_ENTRY_IN_FRONT, notWritableReason, optionNotTakenReason, readOnlyFieldReason, waitTimeoutReason,
} from '../act-component-text.ts'
import type { DrawnEntry } from './entry-container.ts'
import {
  clickTarget, FIELD_KEY, isCovered, isDisabled, isDrawn, marked, namedControls, openDialog, optionLabel,
  scopeOf, selectOf, selectOptions, selectShows, withAttribute,
} from './targets.ts'

/** How often a `wait` step looks again. */
const WAIT_POLL_MS = 50

/**
 * How long a select's list, and then the value it shows, may take to settle
 * after the step's own click.
 *
 * Both are the component's own re-renders rather than network answers, so this
 * is a ceiling on a Vue turn and not on a request.
 */
const SELECT_SETTLE_MS = 1000

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

/**
 * Whether one control refuses a person's own writing.
 *
 * The `readonly` attribute is the platform's way of saying so: a script can
 * still assign the control's value, which is exactly why a write that reported
 * success would be a write nobody made. element-ui draws a select's own input
 * read-only whatever the select's state — the value is chosen, not typed — so
 * this is asked of a field only after it was told apart from a select.
 * @param el - the control.
 * @returns whether it is read-only.
 */
function isReadOnly(el: Element): boolean {
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly
}

/**
 * Wait for one condition to hold, up to a deadline.
 * @param holds - the condition, read again every turn.
 * @param timeoutMs - how long it may take to hold.
 * @returns whether it held in time.
 */
async function settles(holds: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  for (;;) {
    if (holds()) return true
    if (Date.now() >= until) return false
    await delay(Math.min(WAIT_POLL_MS, Math.max(until - Date.now(), 1)))
  }
}

/**
 * Fill one select field the way a person chooses an option.
 *
 * A select's value lives in the component rather than in the input the entry
 * marks — element-ui's input is read-only and shows the chosen label; the value
 * itself is the component's — so a write through the input would be reported as
 * a write the component never took. The step performs the gesture instead: open
 * the list, choose the one drawn option whose label is the value, and report
 * done only once the select displays it. Every way that can fail is a refusal
 * naming the part that failed rather than a step reported as one that ran.
 * @param entry - the drawn entry.
 * @param select - the select the field's control belongs to.
 * @param trigger - the control the field was found by.
 * @param name - the column or property the step named, for the refusals.
 * @param value - the option label the step named.
 * @throws {Error} with the model-facing reason when the value cannot be chosen.
 */
async function fillSelect(entry: DrawnEntry, select: Element, trigger: Element, name: string, value: string): Promise<void> {
  // A select whose list is already drawn is open — a previous step may have
  // left it so, and the toggle this would click is the one that closes it.
  if (selectOptions(select, entry.container).length === 0) clickOn(trigger)
  await settles(() => selectOptions(select, entry.container).length > 0, SELECT_SETTLE_MS)
  const matches = selectOptions(select, entry.container).filter(option => optionLabel(option) === value)
  if (matches.length > 1) throw new Error(ambiguousOptionReason(name, value))
  const option = matches[0]
  if (option === undefined) throw new Error(noOptionReason(name, value))
  clickOn(option)
  const taken = await settles(() => selectShows(select).includes(value), SELECT_SETTLE_MS)
  if (!taken) throw new Error(optionNotTakenReason(name, value))
}

/**
 * Write one value into the field one `set` step named.
 *
 * A text control is written the way a person typing writes it, and a select is
 * filled by choosing an option; the difference is where the component's value
 * lives, not what the step promises. What both share is the refusal: a disabled
 * or read-only control, and a value the control did not take, end the step
 * rather than report a write that never happened.
 * @param entry - the drawn entry.
 * @param target - the control the field was found by.
 * @param name - the column or property the step named.
 * @param value - what to write.
 * @throws {Error} with the model-facing reason when the value cannot be written.
 */
async function setField(entry: DrawnEntry, target: Element, name: string, value: string): Promise<void> {
  if (isDisabled(target)) throw new Error(disabledFieldReason(name))
  const select = selectOf(target, entry.container)
  if (select !== undefined) {
    await fillSelect(entry, select, target, name, value)
    return
  }
  if (isReadOnly(target)) throw new Error(readOnlyFieldReason(name))
  writeValue(target, name, value)
}

/** Wait one turn before looking again. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Wait for one block or one declared control to be drawn.
 * @param entry - the drawn entry.
 * @param step - the wait step.
 * @param timeoutMs - how long the step may wait.
 * @returns whether it was there in time.
 */
async function waitFor(entry: DrawnEntry, step: ActComponentStep & { action: 'wait' }, timeoutMs: number): Promise<boolean> {
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
    // The wait names its own duration in the sentence it fails with, so the
    // step reads it once and the number the model is told is the one it waited.
    const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_MS
    if (!await waitFor(entry, step, timeoutMs)) {
      throw new Error(waitTimeoutReason(`"${step.node ?? step.key}"`, timeoutMs))
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
  await setField(entry, target, step.name, step.value)
}

/**
 * Click one element the way a person would, whatever kind of element it is.
 *
 * An element with its own `click()` is clicked through it, which is what
 * carries the default action and the element's own activation behaviour;
 * anything else — an SVG control in a drawn chart — is given a bubbling click
 * event instead. A `set` step on a select clicks its trigger and its option
 * through here too: it is the same gesture a person makes.
 * @param target - the element to click.
 */
function clickOn(target: Element): void {
  if (target instanceof HTMLElement) {
    target.click()
    return
  }
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

/**
 * Press one element the way a person would, so the block's own handler runs.
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
  clickOn(target)
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
