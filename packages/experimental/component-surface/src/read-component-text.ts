/**
 * The sentences `read_component` is described, refused, and reported with.
 *
 * The description is the tool's whole offer, so it states what the reading
 * answers and how a call addresses the entry it reads, and nothing about the
 * console's own layout. The refusals say only what stopped the call. The
 * report is the reading written out — the same facts, in the same names, a
 * call acts by — and it is composed here rather than in the console so the
 * line shape is written once, whatever composed the reading.
 *
 * What the reading shares with the acting tool — that a target is not part of
 * the entry, which entry is in front — is stated by
 * [the acting tool's own text module](./act-component-text.ts) and used here:
 * the same fact has one sentence, and a reading that said it differently from
 * the step that would be refused by it would be two vocabularies again.
 * @module @deepseek-ai/dsh-experimental-component-surface/read-component-text
 */

import { missingTargetReason } from './act-component-text.ts'
import {
  MAX_READING_CHARS, MAX_READING_LINES, MAX_READING_TEXT_CHARS,
  type ComponentReadControl, type ComponentReadField, type ComponentReading, type ComponentTargetState,
} from './read-component-call.ts'

/** The tool's description: what it reads, how a call addresses it, and what comes back. */
export const READ_COMPONENT_DESCRIPTION = [
  'Read what the component entry the user is looking at in the content panel shows right now, in the same language a call addresses it by.',
  'A call reads exactly one entry: name it with `entry`, the id the entry was placed under,',
  'and it must be the entry currently in front. Nothing outside that entry is described.',
  '`node` narrows the reading to one block, by the id the placement wrote for it; omit it to read the whole entry.',
  '',
  'The answer reports the blocks the entry draws, the controls it draws with the key each one answers to',
  '(an action key, and the control\'s own key where it has one), what each control is, and whether it is disabled',
  'or covered where it is drawn; then the fields the entry names with the values they presently hold;',
  'then whether a write dialog is open.',
  'A reading longer than one answer may carry is cut short and says so.',
].join('\n')

/** What `entry` is. */
export const ENTRY_DESCRIPTION =
  'Id of the component entry to read, the id the entry was placed under. It must be the entry in front.'

/** What `node` is. */
export const NODE_DESCRIPTION = 'The block within the entry, by the id the placement wrote for it. Omit to read the whole entry.'

/** Refusal for a call with no owning session, which has no column to read. */
export const NO_AGENT_REFUSAL =
  'read_component needs a session: the entry it reads belongs to a session\'s content column.'

/** Refusal for an entry id this tool cannot read. */
export const BAD_ENTRY_REFUSAL = 'entry must be the id of a component entry in the content panel.'

/** Refusal for a `node` this tool cannot read. */
export const BAD_NODE_REFUSAL =
  'node must be a block id of letters, digits, underscores and hyphens, as the placement wrote it.'

/** Refusal for a call the runtime cancelled while it waited. */
export const CANCELLED_REFUSAL = 'The read_component call was cancelled.'

/** Refusal for a report that answers a call with something other than a reading. */
export const MISREPORTED_REFUSAL = 'The console answered a read_component call with something other than a reading.'

/**
 * Refusal for a call no console claimed.
 * @param claimTimeoutMs - how long the call waited.
 * @returns the model-facing sentence.
 */
export function unclaimedRefusal(claimTimeoutMs: number): string {
  return `No console showing this session claimed the call within ${String(claimTimeoutMs)}ms, so nothing was read.`
}

/**
 * Refusal for a call a console claimed and never answered.
 * @param answerTimeoutMs - how long the call waited after the claim.
 * @returns the model-facing sentence.
 */
export function unverifiedRefusal(answerTimeoutMs: number): string {
  return `A console claimed the call and reported nothing within ${String(answerTimeoutMs)}ms; the reading never arrived.`
}

/**
 * The rejection one posted failure turns into.
 * @param message - the refusal the console posted.
 * @returns the model-facing sentence.
 */
export function failureRefusal(message: string): string {
  return `read_component did not read: ${message}`
}

/**
 * What the model is told the call read.
 *
 * Composed here rather than in the console's own body so the line shape is
 * written once, and so a reading answered from a console that later version is
 * read the same way as one from this build.
 * @param reading - what the reading found.
 * @returns the report text, cut to the reading's own bounds with a note where it was.
 */
export function readComponentReportText(reading: ComponentReading): string {
  const lines = [`Read the component entry "${reading.entry.title}" (${reading.entry.id}).`]
  lines.push(reading.blocks.length === 0 ? 'Blocks: none.' : `Blocks: ${reading.blocks.join(', ')}.`)
  if (reading.missingNode !== undefined) lines.push(missingTargetReason(`block "${reading.missingNode}"`))
  lines.push(...section('Controls', reading.controls.map(controlLine)))
  lines.push(...section('Fields', reading.fields.map(fieldLine)))
  lines.push(dialogLine(reading.dialogs))
  return bounded(lines)
}

/**
 * One titled section, or the line saying there is nothing in it.
 * @param title - the section's own name.
 * @param lines - the lines under it.
 * @returns the section's lines.
 */
function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [`${title}: none.`] : [`${title}:`, ...lines]
}

/**
 * One control as the reading writes it: the key a step names, what the control
 * is, where it is drawn, and how far a step naming it would get.
 * @param control - the control the reading found.
 * @returns the line.
 */
function controlLine(control: ComponentReadControl): string {
  const key = control.action !== undefined
    ? `"${clip(control.action)}"`
    : `own key "${clip(control.ownKey ?? '')}"`
  const own = control.action === undefined || control.ownKey === undefined ? '' : `, own key "${clip(control.ownKey)}"`
  const words = control.words === '' ? '' : ` "${clip(control.words)}"`
  return `- ${key}${place(control)}: ${control.kind}${words}${own}${stateNote(control.state)}`
}

/**
 * One field as the reading writes it: the name a `set` step writes, what the
 * control is, what it presently holds, and how far a step naming it would get.
 * @param field - the field the reading found.
 * @returns the line.
 */
function fieldLine(field: ComponentReadField): string {
  const held = field.secret === true
    ? ' = (hidden)'
    : field.checked === undefined
      ? field.value === undefined ? '' : ` = "${clip(field.value)}"`
      : field.checked ? ' [x]' : ' [ ]'
  return `- "${clip(field.name)}"${place(field)}: ${field.kind}${held}${stateNote(field.state)}`
}

/**
 * Where one target is drawn, as the reading names it: the block, the open
 * dialog, both, or nowhere the entry draws under a name.
 * @param target - the control or field.
 * @returns the parenthetical, or the empty string.
 */
function place(target: { readonly node?: string; readonly dialog?: string }): string {
  const parts = [
    ...target.node === undefined ? [] : [`in ${clip(target.node)}`],
    // An empty name is the dialog that draws none: the placement is the same
    // fact, said without the quotes a name carries.
    ...target.dialog === undefined ? []
      : [target.dialog === '' ? 'in the dialog' : `in the dialog "${clip(target.dialog)}"`],
  ]
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`
}

/**
 * What one target's state adds to its line.
 * @param state - where the target stands.
 * @returns the trailing note, empty for one a person could use as drawn.
 */
function stateNote(state: ComponentTargetState): string {
  switch (state) {
    case 'reachable': return ''
    case 'disabled': return ' (disabled)'
    case 'covered': return ' (covered where it is drawn)'
    /* v8 ignore next 2 -- the state union is closed and typed; the arm keeps a new state loud */
    default: return ''
  }
}

/**
 * The dialogs an entry has open, said as the reading says them.
 * @param dialogs - the names the open dialogs draw, empty-valued where one draws none.
 * @returns the line.
 */
function dialogLine(dialogs: readonly string[]): string {
  if (dialogs.length === 0) return 'No dialog is open.'
  const names = dialogs.map(name => name === '' ? 'unnamed' : `"${clip(name)}"`).join(', ')
  return dialogs.length === 1 ? `Open dialog: ${names}.` : `Open dialogs: ${names}.`
}

/**
 * One run of drawn text as one line of a reading carries it: whitespace
 * collapsed to single spaces — a reading is lines, and a value that drew a
 * newline would split its own record — and cut to
 * {@link MAX_READING_TEXT_CHARS} with an ellipsis where it was longer.
 * @param value - the text as it was drawn.
 * @returns the text as the reading writes it.
 */
function clip(value: string): string {
  const one = value.replace(/\s+/g, ' ').trim()
  return one.length <= MAX_READING_TEXT_CHARS ? one : `${one.slice(0, MAX_READING_TEXT_CHARS - 1)}…`
}

/** Characters held back for the truncation note, which is appended after the last kept line. */
const NOTE_CHARS = 80

/**
 * The line a cut reading ends with.
 * @param lines - how many lines were not shown.
 * @returns the note.
 */
function truncationNote(lines: number): string {
  return lines === 1
    ? '(Truncated: one more line was not shown.)'
    : `(Truncated: ${String(lines)} more lines were not shown.)`
}

/**
 * Cut a reading to what one answer may carry, saying so where it was cut.
 *
 * Two bounds, a count and a size, and both are held by the same walk: a wide
 * entry draws many short lines and a narrow one may draw a few long ones. The
 * note's own line and its own characters are reserved rather than added, so a
 * cut reading is still inside the bound it was cut for.
 * @param lines - every line the reading composed.
 * @returns the text.
 */
function bounded(lines: readonly string[]): string {
  const kept: string[] = []
  let chars = 0
  for (const [at, line] of lines.entries()) {
    if (kept.length >= MAX_READING_LINES - 1 || chars + line.length + 1 + NOTE_CHARS > MAX_READING_CHARS) {
      return [...kept, truncationNote(lines.length - at)].join('\n')
    }
    kept.push(line)
    chars += line.length + 1
  }
  return kept.join('\n')
}
