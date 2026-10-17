/**
 * The sentences `act_component` is described, refused, and reported with.
 *
 * The description states the addressing vocabulary — entry, block, declared
 * action key or a control's own key, row key, field name — and nothing about
 * the console's layout. Refusals say only
 * what stopped the call and never describe what stands outside the named entry.
 * @module @deepseek-ai/dsh-experimental-component-surface/act-component-text
 */

import type { ActComponentStep, ActComponentStepResult, IgnoredStepField } from './act-component-call.ts'
import { MAX_ACT_COMPONENT_STEPS, MAX_MESSAGE_CHARS } from './act-component-call.ts'

/** The tool's description: what it acts on, how a call addresses it, and what comes back. */
export const ACT_COMPONENT_DESCRIPTION = [
  'Act inside the component entry the user is looking at in the content panel.',
  'A call acts on exactly one entry: name it with `entry`, the id the entry was placed under,',
  'and it must be the entry currently in front. Nothing outside that entry — the console\'s own controls,',
  'another entry, the chat input — is ever touched, and a step that resolves outside it is refused.',
  '',
  'Steps address the components\' own language, never a DOM reference:',
  '- `click` presses one control: name it by the action key a block declares for it (a toolbar button\'s `add`),',
  '  or, where several drawn controls share one action — one button per listed item — by that control\'s own key;',
  '  where a table draws the control once per row, add `row`, the key the row carries, to press the one in that row.',
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
export const KEY_DESCRIPTION =
  'The control this step presses or waits for: its action key, or its own key where several drawn controls share one action.'

/** What `row` is. */
export const ROW_DESCRIPTION =
  'For a click only: the row the control is drawn in, by the key the row carries. Omit for a control outside every row.'

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

/**
 * What one step is refused for when it carries a field naming a target or a
 * value its action does not take.
 * @param ignored - the action and the field it carried.
 * @returns the reason, for {@link stepRefusal}.
 */
export function ignoredFieldReason(ignored: IgnoredStepField): string {
  switch (ignored.action) {
    case 'click': return `a click presses one control named by its key, so it takes no "${ignored.field}".`
    case 'set': return `a set writes the one field its name addresses, so it takes no "${ignored.field}".`
    case 'wait': return `a wait waits for a block or a control, so it takes no "${ignored.field}".`
    /* v8 ignore start -- IgnoredStepField is closed and every variant returns above. */
    default: {
      // Not `assertNever` from dsh-llm, for the reason validate.ts states at its
      // own exhaustiveness check: this module is loaded by the browser seat.
      const unhandled: never = ignored
      throw new Error(`component-surface: unhandled field ${JSON.stringify(unhandled)}`)
    }
    /* v8 ignore stop */
  }
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
  'a step must name `click`, `set`, or `wait`, with the block, key, row, name, or value that action takes, '
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

/** Most own keys, blocks or rows one shared-key sentence lists; the rest are counted. */
export const MAX_LISTED_NAMES = 10

/**
 * Where a step looked, in the wording the shared-key sentences use.
 * @param node - the block the step named, absent for the whole entry.
 * @returns the phrase.
 */
function lookedIn(node: string | undefined): string {
  return node === undefined ? 'in the entry' : `in block "${node}"`
}

/**
 * One sentence listing names between an opening and a closing. The list stops
 * at {@link MAX_LISTED_NAMES}, and earlier where the sentence would pass
 * {@link MAX_MESSAGE_CHARS}, the bound a host reads one step's sentence
 * against; the names left out are counted.
 * @param opening - the words before the list.
 * @param names - the names, in document order.
 * @param closing - the words after the list, ending the sentence.
 * @returns the sentence.
 */
function listed(opening: string, names: readonly string[], closing: string): string {
  const sentence = (shown: number): string => {
    const hidden = names.length - shown
    return `${opening}${names.slice(0, shown).join(', ')}${hidden === 0 ? '' : ` and ${String(hidden)} more`}${closing}`
  }
  let shown = Math.min(names.length, MAX_LISTED_NAMES)
  while (shown > 1 && sentence(shown).length > MAX_MESSAGE_CHARS) shown -= 1
  return sentence(shown)
}

/**
 * Where several drawn controls one key names stand by block, as far as a
 * `node` naming one of the blocks would look at fewer of them.
 */
export interface ControlSpread {
  /** The blocks a step could name as `node`, each once, in document order. */
  readonly blocks: readonly string[]
  /** How many of the controls are drawn inside the scope and outside every block. */
  readonly outside: number
  /** How many of the controls are drawn in blocks whose id no step could name. */
  readonly unnamed: number
  /** How many such blocks there are. */
  readonly unnamedBlocks: number
}

/**
 * Where several drawn controls one key names stand by row, as far as a `row`
 * naming one of the rows would look at fewer of them.
 */
export interface ControlRows {
  /** The row keys a step could name, each once, in document order. */
  readonly keys: readonly string[]
  /**
   * Whether a row draws more than one of the controls: `none`, `told-apart`
   * where each such row's controls carry own keys that name every one of them,
   * and `not-told-apart` otherwise.
   */
  readonly crowded: 'none' | 'told-apart' | 'not-told-apart'
  /** How many of the controls are drawn in no row a step could name. */
  readonly rowless: number
}

/** The controls one refused `click` step's key names where the step looked. */
export interface SharedKey {
  /** The key the step named. */
  readonly key: string
  /** Whether the controls declare the key as their action or carry it as their own key. */
  readonly by: 'action' | 'own-key'
  /** How many drawn controls carry it there. */
  readonly count: number
  /** The block the step named, absent for the whole entry. */
  readonly node: string | undefined
  /** The row the step named, absent where it named none. */
  readonly row: string | undefined
}

/**
 * The words naming a shared key and how many controls carry it, in the row the step named.
 * @param shared - the controls the key names.
 * @returns the phrase every shared-key sentence opens with.
 */
function subjectOf(shared: SharedKey): string {
  const count = String(shared.count)
  const row = shared.row === undefined ? '' : ` of row "${shared.row}"`
  return shared.by === 'action'
    ? `action "${shared.key}" names ${count} drawn controls${row}`
    : `own key "${shared.key}" is carried by ${count} drawn controls${row}`
}

/**
 * The sentence refusing a key whose controls are drawn in more than one block,
 * where a `node` naming one of the blocks looks at fewer of them: the blocks,
 * bounded as {@link listed} states, and the controls no `node` names, counted.
 * @param shared - the controls the key names.
 * @param spread - where they stand by block.
 * @returns the model-facing sentence.
 */
export function spreadReason(shared: SharedKey, spread: ControlSpread): string {
  const subject = subjectOf(shared)
  const advice = '; name one of them as `node` to look in that block alone.'
  if (spread.outside === 0 && spread.unnamed === 0) {
    const of = shared.node === undefined ? 'of the entry' : `inside block "${shared.node}"`
    return listed(`${subject} in ${String(spread.blocks.length)} blocks ${of}: `, spread.blocks, advice)
  }
  const unnamed = spread.unnamedBlocks === 1 ? 'a block' : 'blocks'
  const apart = [
    spread.outside === 0 ? '' : `${String(spread.outside)} of them outside every block`,
    spread.unnamed === 0 ? '' : `${String(spread.unnamed)} of them in ${unnamed} whose id no step can name`,
  ].filter(part => part !== '').join(' and ')
  const one = spread.blocks.length === 1
  return listed(
    `${subject} ${lookedIn(shared.node)}, ${apart}; the rest are in ${one ? 'block ' : `${String(spread.blocks.length)} blocks: `}`,
    spread.blocks,
    one ? '; name it as `node` to look in that block alone.' : advice,
  )
}

/**
 * The sentence refusing a key whose controls are drawn in more than one row of
 * one place, where a `row` naming one of the rows looks at fewer of them: the
 * row keys, bounded as {@link listed} states, what is left to tell apart in a
 * row drawing more than one, and the controls no `row` names, counted.
 * @param shared - the controls the key names.
 * @param rows - where they stand by row.
 * @returns the model-facing sentence.
 */
export function rowsReason(shared: SharedKey, rows: ControlRows): string {
  const subject = `${subjectOf(shared)} ${lookedIn(shared.node)}`
  const placed = rows.crowded === 'none' && rows.rowless === 0
    ? `${subject}, one per row`
    : `${subject} across ${String(rows.keys.length)} row${rows.keys.length === 1 ? '' : 's'}`
  const tails = [
    rows.crowded === 'told-apart' ? '; a row draws more than one of them, so name the one to press by its own key with `row`' : '',
    rows.crowded === 'not-told-apart' ? '; a row draws more than one of them, and no step can tell those apart' : '',
    rows.rowless === 0 ? '' : `; ${String(rows.rowless)} of them ${rows.rowless === 1 ? 'is' : 'are'} drawn in no row a step can name`,
  ]
  return listed(`${placed}; name the row with \`row\`: `, rows.keys, `${tails.join('')}.`)
}

/**
 * The sentence a console posts for an action key several drawn controls
 * declare, each with an own key that names it; the own keys are bounded as
 * {@link listed} states.
 * @param shared - the controls the key names.
 * @param ownKeys - each control's own key, in document order.
 * @returns the model-facing sentence.
 */
export function sharedActionReason(shared: SharedKey, ownKeys: readonly string[]): string {
  return listed(`${subjectOf(shared)} ${lookedIn(shared.node)}; name the one to press by its own key: `, ownKeys, '.')
}

/**
 * The sentence a console posts for a key several drawn controls carry where
 * nothing a step can name tells them apart: no block or row a step could name
 * looks at fewer of them, and — for an action key — one of them carries no own
 * key a step can name, or two carry the same. The component drew them that
 * way, so no wording of the step separates them.
 * @param shared - the controls the key names.
 * @returns the model-facing sentence.
 */
export function inseparableReason(shared: SharedKey): string {
  const subject = `${subjectOf(shared)} ${lookedIn(shared.node)}`
  return shared.by === 'action'
    ? `${subject}, and no step can name each of them by an own key.`
    : `${subject}, so no step can tell them apart.`
}

/**
 * The sentence a console posts for a row the step named that nothing drawn
 * where it looked carries: a row the component no longer draws, or a key it
 * never gave a row.
 * @param row - the row key the step named.
 * @param node - the block the step named, absent for the whole entry.
 * @returns the model-facing sentence.
 */
export function rowNotDrawnReason(row: string, node: string | undefined): string {
  return `row "${row}" is not drawn ${lookedIn(node)}.`
}

/**
 * The sentence a console posts for a row that is drawn and holds none of the
 * drawn controls the key names, which are drawn in other rows or in none.
 * @param key - the key the step named.
 * @param row - the row key the step named.
 * @param node - the block the step named, absent for the whole entry.
 * @returns the model-facing sentence.
 */
export function notInRowReason(key: string, row: string, node: string | undefined): string {
  return `row "${row}" draws no control "${key}" ${lookedIn(node)}.`
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
 * The sentence a console posts for a native select's option the block draws
 * disabled, which no person could choose either.
 * @param name - the column or property the step named.
 * @param value - the option label the step named.
 * @returns the model-facing sentence.
 */
export function disabledOptionReason(name: string, value: string): string {
  return `The field for "${name}" has the option "${value}" disabled, so this call cannot choose it.`
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
    case 'click':
      return `click ${step.node === undefined ? '' : `in ${step.node} `}on "${step.key}"${step.row === undefined ? '' : ` of row "${step.row}"`}`
    case 'set': return `set "${step.name}"${step.node === undefined ? '' : ` in ${step.node}`}`
    case 'wait': return `wait for ${step.node ?? step.key}`
    /* v8 ignore start -- ActComponentStep is closed and every variant returns above. */
    default: {
      // Not `assertNever` from dsh-llm, for the reason validate.ts states at its
      // own exhaustiveness check: this module is loaded by the browser seat.
      const unhandled: never = step
      throw new Error(`component-surface: unhandled step ${JSON.stringify(unhandled)}`)
    }
    /* v8 ignore stop */
  }
}
