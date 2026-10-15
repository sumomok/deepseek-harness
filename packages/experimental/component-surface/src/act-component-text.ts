/**
 * The sentences `act_component` is described, refused, and reported with.
 *
 * The description states the addressing vocabulary — entry, block, declared
 * key, field name — and nothing about the console's layout. Refusals say only
 * what stopped the call and never describe what stands outside the named entry.
 * @module @deepseek-ai/dsh-experimental-component-surface/act-component-text
 */

import type { ActComponentStep, ActComponentStepResult } from './act-component-call.ts'
import { MAX_ACT_COMPONENT_STEPS } from './act-component-call.ts'

/** The tool's description: what it acts on, how a call addresses it, and what comes back. */
export const ACT_COMPONENT_DESCRIPTION = [
  'Act inside the component entry the user is looking at in the content panel.',
  'A call acts on exactly one entry: name it with `entry`, the id the entry was placed under,',
  'and it must be the entry currently in front. Nothing outside that entry — the console\'s own controls,',
  'another entry, the chat input — is ever touched, and a step that resolves outside it is refused.',
  '',
  'Steps address the components\' own language, never a DOM reference:',
  '- `click` presses the control a block declares under an action key (a toolbar button\'s `add`, a bar\'s submit).',
  '- `set` writes a value into the field the entry names for one column or property (a filter value on `zh_label`);',
  '  a field drawn as a select or a suggestion field is set by choosing the option whose label is the value.',
  '- `wait` waits until a block or a declared control is drawn, for a call that acts on what it just asked for.',
  '`node` names the block within the entry (the id the placement wrote); omit it to search the whole entry.',
  '',
  'The answer says which steps ran, which one stopped the call and why, and what the entry\'s controls reported.',
].join('\n')

/** What `entry` is. */
export const ENTRY_DESCRIPTION =
  'Id of the component entry to act on, the id the entry was placed under. It must be the entry in front.'

/** What `steps` is. */
export const STEPS_DESCRIPTION = `The steps to run, in order, at most ${String(MAX_ACT_COMPONENT_STEPS)}. The call stops at the first step that fails.`

/** What `action` is. */
export const ACTION_DESCRIPTION = 'What the step does: press a declared control, write a field, or wait for something to be drawn.'

/** What `node` is. */
export const NODE_DESCRIPTION = 'The block within the entry, by the id the placement wrote for it. Omit to search the whole entry.'

/** What `key` is. */
export const KEY_DESCRIPTION = 'The action key the component declares for the control this step presses, or waits for.'

/** What `name` is. */
export const NAME_DESCRIPTION = 'The column or property the field is named by, as the component labels it.'

/** What `value` is. */
export const VALUE_DESCRIPTION = 'What to write into the field; for a select or a suggestion field, the label of the option to choose.'

/** What `timeoutMs` is. */
export const TIMEOUT_DESCRIPTION = 'How long the wait may last, in milliseconds. Omit for the default; the ceiling is enforced.'

/** Refusal for a call carrying no steps at all. */
export const NO_STEPS_REFUSAL = 'act_component needs at least one step.'

/**
 * Refusal for a call carrying more steps than one call may run.
 * @param max - the ceiling this deployment runs with.
 * @returns the model-facing sentence.
 */
export function tooManyStepsRefusal(max: number): string {
  return `act_component runs at most ${String(max)} steps in one call.`
}

/**
 * Refusal for one step this tool cannot read.
 * @param index - which step, counting from 1.
 * @param reason - what is wrong with it.
 * @returns the model-facing sentence.
 */
export function stepRefusal(index: number, reason: string): string {
  return `step ${String(index)}: ${reason}`
}

/** Refusal for a call with no owning session, which has no column to act on. */
export const NO_AGENT_REFUSAL =
  'act_component needs a session: the entry it acts on belongs to a session\'s content column.'

/** Refusal for a call the runtime cancelled while it waited. */
export const CANCELLED_REFUSAL = 'The act_component call was cancelled.'

/** Refusal for a report that answers a call with something other than steps. */
export const MISREPORTED_REFUSAL = 'The console answered an act_component call with something other than its steps.'

/** Refusal for an entry id this tool cannot read. */
export const BAD_ENTRY_REFUSAL = 'entry must be the id of a component entry in the content panel.'

/** What one unreadable step is refused for, which is the same list every time. */
export const STEP_REFUSAL_TEXT =
  'a step must name `click`, `set`, or `wait`, with the block, key, name, or value that action takes, '
  + 'in the components\' own alphabet of letters, digits, underscores and hyphens.'

/**
 * Refusal for a call no console claimed.
 * @param claimTimeoutMs - how long the call waited.
 * @returns the model-facing sentence.
 */
export function unclaimedRefusal(claimTimeoutMs: number): string {
  return `No console showing this session claimed the call within ${String(claimTimeoutMs)}ms, so no step ran.`
}

/**
 * Refusal for a call a console claimed and never answered.
 * @param answerTimeoutMs - how long the call waited after the claim.
 * @returns the model-facing sentence.
 */
export function unverifiedRefusal(answerTimeoutMs: number): string {
  return `A console claimed the call and reported nothing within ${String(answerTimeoutMs)}ms; `
    + 'the steps may have run in full, in part, or not at all.'
}

/**
 * The rejection one posted failure turns into.
 * @param message - the refusal the console posted.
 * @returns the model-facing sentence.
 */
export function failureRefusal(message: string): string {
  return `act_component did not run: ${message}`
}

/** The sentence a console posts when no component entry is in front at all. */
export const NO_ENTRY_IN_FRONT = 'No component entry is in front, so there is nothing to act on.'

/**
 * The sentence a console posts when another entry is in front.
 * @param inFront - the id of the entry the console is drawing.
 * @returns the model-facing sentence.
 */
export function anotherEntryInFront(inFront: string): string {
  return `The entry in front is "${inFront}", not the one this call named.`
}

/** The sentence a console posts when the entry it started on was redrawn under it. */
export const ENTRY_REDRAWN_REASON = 'The entry was redrawn while this call was running.'

/**
 * The sentence a console posts for the step the call's deadline stopped: one
 * that would have started past it, or one whose wait it cut short. A wait the
 * deadline cut short is not reported as a missing option or target.
 */
export const OUT_OF_TIME_REASON = 'The console\'s time for this call ran out before this step finished.'

/**
 * The sentence a console posts for a control it may not press.
 * @param key - the action key the step named.
 * @returns the model-facing sentence.
 */
export function disabledReason(key: string): string {
  return `control "${key}" is disabled.`
}

/**
 * The sentence a console posts for a control something else is drawn over.
 * @param key - the action key the step named.
 * @returns the model-facing sentence.
 */
export function coveredReason(key: string): string {
  return `control "${key}" is covered where it is drawn.`
}

/**
 * The sentence a console posts for a control the entry holds but does not
 * draw, such as a closed row confirmation or dialog. The entry does hold the
 * key, so {@link missingTargetReason} would be false here.
 * @param key - the action key the step named.
 * @returns the model-facing sentence.
 */
export function notDrawnReason(key: string): string {
  return `control "${key}" is not drawn, so this call cannot press it.`
}

/**
 * The sentence a console posts for a step whose target the entry does not
 * declare, whether the target is nowhere or drawn outside the entry.
 * @param target - what the step named.
 * @returns the model-facing sentence.
 */
export function missingTargetReason(target: string): string {
  return `${target} is not part of the entry on display.`
}

/**
 * The sentence a console posts for a wait whose target never appeared; the
 * target may be one the entry declares and did not draw in time.
 * @param target - what the step waited for, named as the step names it.
 * @param timeoutMs - how long the wait lasted.
 * @returns the model-facing sentence.
 */
export function waitTimeoutReason(target: string, timeoutMs: number): string {
  return `${target} did not appear within ${String(timeoutMs)}ms.`
}

/**
 * The sentence a console posts for a field the entry names but cannot be written.
 * @param name - the column or property the step named.
 * @returns the model-facing sentence.
 */
export function notWritableReason(name: string): string {
  return `The field for "${name}" is not one this call may write.`
}

/**
 * The sentence a console posts for a name the entry draws more than once, as
 * when a query panel and an open write dialog both carry the column's name.
 * @param name - the column or property the step named.
 * @returns the model-facing sentence.
 */
export function ambiguousFieldReason(name: string): string {
  return `field "${name}" is drawn more than once in the entry, so this call cannot tell which one to write.`
}

/**
 * The sentence a console posts for a field the entry draws disabled, which no
 * person could write either.
 * @param name - the column or property the step named.
 * @returns the model-facing sentence.
 */
export function disabledFieldReason(name: string): string {
  return `The field for "${name}" is disabled, so this call cannot write it.`
}

/**
 * The sentence a console posts for a field the entry draws read-only: a script
 * assignment would show while the component behind it may never see it.
 * @param name - the column or property the step named.
 * @returns the model-facing sentence.
 */
export function readOnlyFieldReason(name: string): string {
  return `The field for "${name}" is read-only, so this call cannot write it.`
}

/**
 * The sentence a console posts for a field whose value is chosen — a select,
 * or an autocomplete's suggestions — with no drawn option the value names.
 * @param name - the column or property the step named.
 * @param value - the option label the step named.
 * @returns the model-facing sentence.
 */
export function noOptionReason(name: string, value: string): string {
  return `The field for "${name}" has no option "${value}".`
}

/**
 * The sentence a console posts for a field whose value is chosen drawing more
 * than one option with the value as its label.
 * @param name - the column or property the step named.
 * @param value - the option label the step named.
 * @returns the model-facing sentence.
 */
export function ambiguousOptionReason(name: string, value: string): string {
  return `The field for "${name}" draws more than one option "${value}", so this call cannot tell which to choose.`
}

/**
 * The sentence a console posts for a choice the component did not confirm: a
 * select displaying no such option, or an autocomplete not closing its panel
 * on it.
 * @param name - the column or property the step named.
 * @param value - the option label the step named.
 * @returns the model-facing sentence.
 */
export function optionNotTakenReason(name: string, value: string): string {
  return `The field for "${name}" did not take the option "${value}".`
}

/**
 * What the model is told the call did, composed by the console that ran it.
 * @param entry - the entry the steps ran on, as the console named it.
 * @param steps - the steps the call asked for.
 * @param results - how each of them ended.
 * @returns the report text.
 */
export function actComponentReportText(
  entry: { readonly id: string; readonly title: string },
  steps: readonly ActComponentStep[],
  results: readonly ActComponentStepResult[],
): string {
  const lines = [`Acted on the component entry "${entry.title}" (${entry.id}).`]
  for (const result of results) {
    const step = steps[result.index - 1]
    const named = step === undefined ? `step ${String(result.index)}` : describeStep(step)
    if (result.status === 'ok') lines.push(`- ${named}: done`)
    else if (result.status === 'failed') lines.push(`- ${named}: ${result.message}`)
    else lines.push(`- ${named}: not run`)
  }
  return lines.join('\n')
}

/**
 * Name one step the way a reader of the report knows it.
 * @param step - the step.
 * @returns the phrase.
 */
function describeStep(step: ActComponentStep): string {
  switch (step.action) {
    case 'click': return `click ${step.node === undefined ? '' : `in ${step.node} `}on "${step.key}"`
    case 'set': return `set "${step.name}"${step.node === undefined ? '' : ` in ${step.node}`}`
    case 'wait': return `wait for ${step.node ?? step.key}`
  }
}
