/**
 * The browser half of `act_component`: it runs one call's steps inside the
 * element the content column is drawing the named entry in.
 *
 * Every target is resolved inside that element through
 * [the shared resolution](./targets.ts), bounded by the block the step names or
 * by the whole entry. Actions go through the block's own handlers: a press is
 * the element's `click()`, refused for a control that is disabled, covered, or
 * not drawn; a write goes through the prototype's value setter and dispatches
 * `input` and `change`; a select or a suggestion field is filled by choosing
 * the option whose label is the value and waiting for the component to take it.
 *
 * Before every step and on every look a wait makes, the entry in front is read
 * again, and the run stops once it is not the entry the call was claimed
 * against. No step starts past the call's deadline and every wait ends at it,
 * since the host stops waiting for the report then; the step it stops fails
 * saying so, and the steps behind it are not run.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/act-executor
 */

import {
  DEFAULT_WAIT_MS,
  type ActComponentArgs,
  type ActComponentStep,
  type ActComponentStepResult,
  type ActComponentWait,
} from '../act-component-call.ts'
import {
  actComponentReportText, ambiguousFieldReason, ambiguousOptionReason, anotherEntryInFront, coveredReason,
  disabledFieldReason, disabledOptionReason, disabledReason, ENTRY_REDRAWN_REASON, missingTargetReason,
  noOptionReason, NO_ENTRY_IN_FRONT, notWritableReason, notDrawnReason, optionNotTakenReason, OUT_OF_TIME_REASON,
  readOnlyFieldReason, waitTimeoutReason,
} from '../act-component-text.ts'
import type { DrawnEntry } from './entry-container.ts'
import {
  addedAskingRow, askingRowPresent, autocompleteOf, autocompleteOptions, clickTarget, FIELD_KEY, isCovered, isDisabled,
  isDrawn, marked, namedControls, openDialog, optionLabel, scopeOf, selectOf, selectOptions, selectShows, undrawnTarget,
  withAttribute,
} from './targets.ts'

/** How often a wait looks again. */
const WAIT_POLL_MS = 50

/**
 * How long a select's list, the value it shows, an autocomplete's panel, the
 * start of an autocomplete's query, and a query the field's earlier text left
 * out may take. The first four are the component's own re-render or debounce
 * rather than a network answer, so this bounds a Vue turn and not a request;
 * the fifth is an answer this step gives up on rather than waits for.
 */
const SELECT_SETTLE_MS = 1000

/** The call one step runs in. */
interface StepRun {
  /** The entry the call was claimed against. */
  readonly entry: DrawnEntry
  /** How the console reads the entry in front now. */
  readonly locate: () => DrawnEntry | undefined
  /** The moment the call's steps must be over by, as a `Date.now()` value. */
  readonly deadline: number
}

/**
 * The field one `set` step writes into: the controls declaring the name with
 * {@link FIELD_KEY}, else those whose own accessible name it is. A drawn candidate
 * inside an open dialog wins over other drawn ones, and two drawn candidates
 * left are refused; where none is drawn, the first candidate is taken.
 * @param scope - the subtree the step is confined to.
 * @param name - the column or property the step named.
 * @param within - the entry's own container, which bounds what may name a field.
 * @returns the control, or undefined when the subtree names none.
 * @throws {Error} when more than one drawn candidate remains for the name.
 */
function setTarget(scope: Element, name: string, within: Element): Element | undefined {
  const declared = withAttribute(scope, FIELD_KEY).filter(el => marked(el, FIELD_KEY, name))
  const candidates = declared.length > 0 ? declared : namedControls(scope, name, within)
  const drawn = candidates.filter(el => isDrawn(el, within))
  const inDialog = drawn.filter(el => openDialog(el, within) !== undefined)
  const chosen = inDialog.length > 0 ? inDialog : drawn
  if (chosen.length > 1) throw new Error(ambiguousFieldReason(name))
  return chosen[0] ?? candidates[0]
}

/**
 * Tell the block one control changed, the way a person's own edit does.
 * @param el - the control that changed.
 */
function announce(el: Element): void {
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

/**
 * Write one value into a form control the way a person typing would: through
 * the prototype's setter, which a controlled component's own `value` accessor
 * would otherwise intercept.
 * @param el - the control to write into.
 * @param name - the column or property the step named, for the refusal.
 * @param value - what to write.
 * @throws {Error} when the control did not take the value.
 */
function writeValue(el: Element, name: string, value: string): void {
  if (el instanceof HTMLInputElement) Reflect.set(HTMLInputElement.prototype, 'value', value, el)
  else if (el instanceof HTMLTextAreaElement) Reflect.set(HTMLTextAreaElement.prototype, 'value', value, el)
  // Read back rather than assumed: a number input refuses text it cannot hold.
  if ((el as HTMLInputElement).value !== value) throw new Error(notWritableReason(name))
  announce(el)
}

/**
 * Choose one option of a native select by the label it shows, the reading a
 * drawn select's options are matched by; an option's `value` attribute is the
 * form's own encoding, which nothing on screen shows.
 * @param select - the select.
 * @param name - the column or property the step named, for the refusals.
 * @param label - the option label the step named.
 * @throws {Error} when no option, or more than one, shows the label, and when
 * the one match is disabled.
 */
function chooseOption(select: HTMLSelectElement, name: string, label: string): void {
  const matches = [...select.options].filter(option => optionLabel(option) === label)
  if (matches.length > 1) throw new Error(ambiguousOptionReason(name, label))
  const option = matches[0]
  if (option === undefined) throw new Error(noOptionReason(name, label))
  // A disabled option is one a person cannot choose either, whatever the
  // select's own state; an option inside a disabled group is disabled too.
  if (option.matches(':disabled')) throw new Error(disabledOptionReason(name, label))
  option.selected = true
  announce(select)
}

/**
 * Whether one control refuses a person's own writing. element-ui draws a
 * select's own input read-only whatever the select's state, so this is asked
 * of a field only after it was told apart from a select.
 * @param el - the control.
 * @returns whether it is read-only.
 */
function isReadOnly(el: Element): boolean {
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly
}

/**
 * Wait for one condition to hold, up to the wait's own ceiling and never past
 * the call's deadline, reading the entry in front again on every look before
 * the condition.
 * @param run - the call the wait belongs to.
 * @param holds - the condition, read again every turn.
 * @param ceilingMs - how long this wait may take by itself.
 * @returns whether it held before the ceiling.
 * @throws {Error} with the reason the entry is no longer the one in front,
 * with the out-of-time reason when the deadline came first, and with whatever
 * `holds` throws.
 */
async function settles(run: StepRun, holds: () => boolean, ceilingMs: number): Promise<boolean> {
  const until = Math.min(Date.now() + ceilingMs, run.deadline)
  for (;;) {
    const displaced = displacedReason(run)
    if (displaced !== undefined) throw new Error(displaced)
    if (holds()) return true
    const now = Date.now()
    if (now >= run.deadline) throw new Error(OUT_OF_TIME_REASON)
    if (now >= until) return false
    await delay(Math.min(WAIT_POLL_MS, Math.max(until - now, 1)))
  }
}

/**
 * Fill one element-ui select field: open the list, click the one drawn option
 * whose label is the value, and finish once the select displays it. The input
 * only shows the label; the value lives in the component.
 * @param run - the call the step belongs to.
 * @param select - the select the field's control belongs to.
 * @param trigger - the control the field was found by.
 * @param name - the column or property the step named, for the refusals.
 * @param value - the option label the step named.
 * @throws {Error} with the model-facing reason when the value cannot be chosen.
 */
async function fillSelect(run: StepRun, select: Element, trigger: Element, name: string, value: string): Promise<void> {
  const within = run.entry.container
  // A list already drawn is open, and the toggle would close it.
  if (selectOptions(select, within).length === 0) clickOn(trigger)
  await settles(run, () => selectOptions(select, within).length > 0, SELECT_SETTLE_MS)
  const matches = selectOptions(select, within).filter(option => optionLabel(option) === value)
  if (matches.length > 1) throw new Error(ambiguousOptionReason(name, value))
  const option = matches[0]
  if (option === undefined) throw new Error(noOptionReason(name, value))
  clickOn(option)
  const taken = await settles(run, () => selectShows(select).includes(value), SELECT_SETTLE_MS)
  if (!taken) throw new Error(optionNotTakenReason(name, value))
}

/**
 * Fill one element-ui suggestion field by choosing a suggestion, which alone
 * carries the block's record of the value. A refusal puts back the text the
 * field held and closes the panel, unless the entry is no longer in front, in
 * which case the field is left alone.
 * @param run - the call the step belongs to.
 * @param autocomplete - the autocomplete the field's control belongs to.
 * @param trigger - the control the field was found by.
 * @param name - the column or property the step named, for the refusals.
 * @param value - the suggestion label the step named.
 * @throws {Error} with the model-facing reason when the value cannot be chosen.
 */
async function fillAutocomplete(run: StepRun, autocomplete: Element, trigger: Element, name: string, value: string): Promise<void> {
  if (!(trigger instanceof HTMLInputElement || trigger instanceof HTMLTextAreaElement)) throw new Error(notWritableReason(name))
  const before = trigger.value
  try {
    await chooseSuggestion(run, autocomplete, trigger, name, value)
  } catch (refusal) {
    if (displacedReason(run) === undefined) await putBack(run, autocomplete, trigger, name, before)
    throw refusal
  }
}

/**
 * Watch one suggestion field for the row the block draws while a query is out.
 *
 * The row may be drawn and gone between two looks, and the panel holding it may
 * be hidden, so it is recorded from mutations anywhere in the autocomplete
 * rather than looked for: an answer holding no suggestion takes the row away
 * with nothing behind it, and a step that only looked would run on to the
 * call's deadline and report a timeout for a value the block has no suggestion
 * for.
 * @param autocomplete - the autocomplete element.
 * @returns whether the row was seen since the watching began, and the disposer
 * that stops the watching.
 */
function watchAsking(autocomplete: Element): { seen: () => boolean; stop: () => void } {
  let seen = false
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!addedAskingRow(node)) continue
        seen = true
        return
      }
    }
  })
  observer.observe(autocomplete, { childList: true, subtree: true })
  return { seen: () => seen, stop: () => { observer.disconnect() } }
}

/**
 * A wait condition for the block's answer to a query: suggestions drawn, or the
 * asking row having come and gone, which is an answer holding none.
 * @param seenAsking - whether the asking row was seen since the watching began.
 * @param autocomplete - the autocomplete element.
 * @param within - the entry's own container.
 * @returns the condition.
 */
function answered(seenAsking: () => boolean, autocomplete: Element, within: Element): () => boolean {
  return () => {
    if (autocompleteOptions(autocomplete, within).length > 0) return true
    return seenAsking() && !askingRowPresent(autocomplete)
  }
}

/**
 * The gesture {@link fillAutocomplete} performs: focus the field — element-ui
 * draws the panel only for a field it saw focused, and a script's click moves
 * no focus — clear it so the suggestions that come answer this step's own
 * typing, type the value, choose the one drawn suggestion whose label is the
 * value, and be done once the panel closed on the choice.
 *
 * A query the field's earlier text started is waited out before the value is
 * typed, up to the settle ceiling: an answer back inside it lands while the
 * field is empty and is not read as this step's. A query that never calls back
 * leaves the asking row standing past the ceiling, and the step types anyway,
 * its own query's answer being what clears the row.
 * @param run - the call the step belongs to.
 * @param autocomplete - the autocomplete the field's control belongs to.
 * @param trigger - the field's control.
 * @param name - the column or property the step named, for the refusals.
 * @param value - the suggestion label the step named.
 * @throws {Error} with the model-facing reason when the value cannot be chosen.
 */
async function chooseSuggestion(
  run: StepRun,
  autocomplete: Element,
  trigger: HTMLInputElement | HTMLTextAreaElement,
  name: string,
  value: string,
): Promise<void> {
  const within = run.entry.container
  trigger.focus()
  writeValue(trigger, name, '')
  await settles(run, () => autocompleteOptions(autocomplete, within).length === 0, SELECT_SETTLE_MS)
  // A query the field's earlier text started may still be out, and its answer
  // would land as this step's own. The field is empty by now, so waiting for
  // the row to go lets an answer that is back within the ceiling pass with
  // nothing to read. A query the block never answers keeps the row standing —
  // element-ui's one loading flag is cleared by whatever answer comes next —
  // so the step types its own value past the ceiling and lets that answer
  // clear the row.
  await settles(run, () => !askingRowPresent(autocomplete), SELECT_SETTLE_MS)
  const asking = watchAsking(autocomplete)
  try {
    writeValue(trigger, name, value)
    // The suggestions are an answer over the network, so only the call's
    // deadline bounds this wait.
    await settles(run, answered(asking.seen, autocomplete, within), Number.POSITIVE_INFINITY)
    const matches = autocompleteOptions(autocomplete, within).filter(option => optionLabel(option) === value)
    if (matches.length > 1) throw new Error(ambiguousOptionReason(name, value))
    const option = matches[0]
    if (option === undefined) throw new Error(noOptionReason(name, value))
    clickOn(option)
    // The component empties the panel on the choice itself.
    const taken = await settles(run, () => autocompleteOptions(autocomplete, within).length === 0, SELECT_SETTLE_MS)
    if (!taken) throw new Error(optionNotTakenReason(name, value))
  } finally {
    asking.stop()
  }
}

/**
 * Leave a suggestion field holding the text a refused step found, with the
 * panel closed.
 *
 * Writing non-empty text back starts a query, and the vendored kit opens the
 * panel on every answer, so the row the block draws while that query is out is
 * waited for, within the call's time, before closing. The panel is closed with
 * a Tab keydown sent to the `.el-input` root element-ui hears it on — the root
 * of a textarea field is `.el-textarea` — and not bubbled: a listener outside
 * the field still sees it in the capture phase, which is how the console
 * switches to its keyboard-operation styling and how a tooltip opened by a
 * click is dismissed, and a query the restored text never answers keeps the
 * report here until the call's deadline. A blur would let the kit clear a
 * value it holds no record for, and an entry no longer in front is sent no key
 * at all.
 * @param run - the call the step belongs to.
 * @param autocomplete - the autocomplete the field's control belongs to.
 * @param trigger - the field's control.
 * @param name - the column or property the step named.
 * @param before - what the field held before the step.
 */
async function putBack(
  run: StepRun,
  autocomplete: Element,
  trigger: HTMLInputElement | HTMLTextAreaElement,
  name: string,
  before: string,
): Promise<void> {
  if (trigger.value !== before) {
    // The row is recorded from before the write, because the query may answer
    // between the write and the first look.
    const asking = watchAsking(autocomplete)
    try {
      writeValue(trigger, name, before)
      if (before !== '') {
        try {
          if (await settles(run, () => asking.seen() || askingRowPresent(autocomplete), SELECT_SETTLE_MS)) {
            await settles(run, () => !askingRowPresent(autocomplete), Number.POSITIVE_INFINITY)
          }
        } catch (_stoppedWaiting) {
          // Out of time or entry gone: the panel is closed anyway, and the
          // rethrown refusal says why the step stopped.
        }
      }
    } finally {
      asking.stop()
    }
  }
  // Another entry may draw in the element this one held, and a key sent into
  // it would close whatever panel that entry has open.
  if (displacedReason(run) !== undefined) return
  const field = trigger.closest('.el-input, .el-textarea')
  if (field === null) return
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: false }))
}

/**
 * Write one value into the field one `set` step named: a text control the way
 * a person types, and a select — drawn or native — or a suggestion field by
 * choosing an option by its label. A disabled or read-only control, and a
 * value the control did not take, end the step rather than report a write
 * that never happened.
 * @param run - the call the step belongs to.
 * @param target - the control the field was found by.
 * @param name - the column or property the step named.
 * @param value - what to write.
 * @throws {Error} with the model-facing reason when the value cannot be written.
 */
async function setField(run: StepRun, target: Element, name: string, value: string): Promise<void> {
  if (isDisabled(target)) throw new Error(disabledFieldReason(name))
  const select = selectOf(target, run.entry.container)
  if (select !== undefined) {
    await fillSelect(run, select, target, name, value)
    return
  }
  const autocomplete = autocompleteOf(target, run.entry.container)
  if (autocomplete !== undefined) {
    await fillAutocomplete(run, autocomplete, target, name, value)
    return
  }
  if (target instanceof HTMLSelectElement) {
    chooseOption(target, name, value)
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
 * @param run - the call the step belongs to.
 * @param step - the wait step.
 * @param timeoutMs - how long the step may wait.
 * @returns whether it was there in time.
 * @throws {Error} with the reason the entry is no longer the one in front, or
 * with the out-of-time reason when the deadline came first.
 */
async function waitFor(run: StepRun, step: ActComponentWait, timeoutMs: number): Promise<boolean> {
  return await settles(run, () => {
    const scope = scopeOf(run.entry, step.node)
    return scope !== undefined && (step.key === undefined || clickTarget(scope, step.key, run.entry.container) !== undefined)
  }, timeoutMs)
}

/**
 * Run one step inside the entry.
 * @param run - the call the step belongs to.
 * @param step - the step to run.
 * @throws {Error} with the model-facing reason when the step cannot run.
 */
async function runStep(run: StepRun, step: ActComponentStep): Promise<void> {
  const { entry } = run
  if (step.action === 'wait') {
    // Read once, so the number the model is told is the one it waited.
    const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_MS
    if (!await waitFor(run, step, timeoutMs)) {
      // What did not appear is the control where the step named a key, and the block otherwise.
      const target = step.node === undefined
        ? `control "${step.key}"`
        : step.key === undefined ? `"${step.node}"` : `control "${step.key}" in "${step.node}"`
      throw new Error(waitTimeoutReason(target, timeoutMs))
    }
    return
  }
  // Every search below is bounded by this scope, the entry's own container or
  // an element inside it, so a missing scope is a named block the entry does
  // not draw.
  const scope = scopeOf(entry, step.node)
  if (scope === undefined) throw new Error(missingTargetReason(`block "${String(step.node)}"`))
  if (step.action === 'click') {
    const target = clickTarget(scope, step.key, entry.container)
    if (target === undefined) {
      throw new Error(undrawnTarget(scope, step.key, entry.container)
        ? notDrawnReason(step.key)
        : missingTargetReason(`control "${step.key}"`))
    }
    press(target, step.key)
    return
  }
  const target = setTarget(scope, step.name, entry.container)
  if (target === undefined) throw new Error(missingTargetReason(`field "${step.name}"`))
  await setField(run, target, step.name, step.value)
}

/**
 * Click one element the way a person would: through its own `click()` where it
 * has one, which carries the default action, and as a bubbling click event
 * otherwise — an SVG control in a drawn chart.
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
 * The click reaches the block whether or not a person could reach the control,
 * so a disabled or covered control is a refusal rather than a press.
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
 * Why the entry the call was claimed against is no longer the one in front: no
 * entry, another one — by the switcher's selected key — or the same one redrawn
 * into a new element, where the steps would run in a subtree nobody sees.
 * @param run - the call the check belongs to.
 * @returns what stopped the call, or undefined while the entry is still the one in front.
 */
function displacedReason(run: StepRun): string | undefined {
  const drawn = run.locate()
  if (drawn === undefined) return NO_ENTRY_IN_FRONT
  if (drawn.entryId !== run.entry.entryId) return anotherEntryInFront(drawn.entryId)
  if (drawn.container !== run.entry.container) return ENTRY_REDRAWN_REASON
  return undefined
}

/**
 * Run one call's steps against the entry the column is drawing. A failing step
 * is a result rather than a rejection: it stops the call, and the steps after
 * it are reported as not run.
 * @param args - the call's arguments.
 * @param entry - the entry the column is drawing, which the caller has matched to the call.
 * @param locate - reads the entry in front again, for the check before every step.
 * @param deadline - the moment the steps must be over by, as a `Date.now()`
 * value: no step starts past it, and every wait a step makes ends at it.
 * @returns what the call ended as.
 */
export async function runActComponent(
  args: ActComponentArgs,
  entry: DrawnEntry,
  locate: () => DrawnEntry | undefined,
  deadline: number,
): Promise<ActComponentRun> {
  const run: StepRun = { entry, locate, deadline }
  const results: ActComponentStepResult[] = []
  let failed = false
  for (const [at, step] of args.steps.entries()) {
    if (failed) {
      results.push({ index: at + 1, status: 'skipped' })
      continue
    }
    try {
      // Vue and React draw on a later task; the step after a press must see
      // what the press drew.
      await delay(0)
      if (Date.now() >= deadline) throw new Error(OUT_OF_TIME_REASON)
      const displaced = displacedReason(run)
      if (displaced !== undefined) throw new Error(displaced)
      await runStep(run, step)
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
