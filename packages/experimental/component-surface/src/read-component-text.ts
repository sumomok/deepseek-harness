/**
 * The sentences `read_component` is described, refused, and reported with.
 *
 * The description states what the reading answers and how a call addresses
 * the entry, and nothing about the console's layout. The report writes a
 * {@link ComponentReading} out as a tree in the names a step acts by; rows are
 * the only part that grows with the data, so an oversized reading gives up row
 * detail first and says so. A fact the acting tool also states — a target not
 * part of the entry, which entry is in front — uses
 * [its sentence](./act-component-text.ts).
 * @module @deepseek-ai/dsh-experimental-component-surface/read-component-text
 */

import { missingTargetReason } from './act-component-text.ts'

export { BAD_ENTRY_REFUSAL } from './act-component-text.ts'
import {
  MAX_READING_CHARS, MAX_READING_LINES, MAX_READING_TEXT_CHARS,
  type ComponentControlKeys, type ComponentReadControl, type ComponentReadDialog, type ComponentReadField, type ComponentReadRow,
  type ComponentReadRows, type ComponentReading, type ComponentReadScope, type ComponentTargetState,
} from './read-component-call.ts'

/** The tool's description: what it reads, how a call addresses it, and what comes back. */
export const READ_COMPONENT_DESCRIPTION = [
  'Read what the component entry the user is looking at in the content panel shows right now, in the same language a call addresses it by.',
  'A call reads exactly one entry: name it with `entry`, the id the entry was placed under,',
  'and it must be the entry currently in front. Nothing outside that entry is described.',
  '`node` narrows the reading to one block, by the id the placement wrote for it; omit it to read the whole entry.',
  '',
  'The answer is a tree: the entry, then each block it draws with the controls it draws (the key each one answers to —',
  'an action key, and the control\'s own key where it has one — what each is, and whether it is disabled or covered),',
  'the fields it names with the values they presently hold, and its rows folded — how many are drawn, what one row draws',
  'counted by key, and the first rows named. Each open write dialog is a node of its own, listed in full: its name,',
  'the block it stands in, its controls and its fields with their values.',
  'A reading larger than one answer may carry gives up row detail before anything else and says what it gave up.',
].join('\n')

/** What `entry` is. */
export const ENTRY_DESCRIPTION =
  'Id of the component entry to read, the id the entry was placed under. It must be the entry in front.'

/** What `node` is. */
export const NODE_DESCRIPTION = 'The block within the entry, by the id the placement wrote for it. Omit to read the whole entry.'

/** Refusal for a call with no owning session, which has no column to read. */
export const NO_AGENT_REFUSAL =
  'read_component needs a session: the entry it reads belongs to a session\'s content column.'

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

/** How much of the folded row detail one answer carries. */
type RowDetail =
  /** Everything: how many rows, what one draws, and the names. */
  | 'full'
  /** The count and what one row draws, without the names. */
  | 'summary'
  /** The count alone, and the sentence saying why the rest is not here. */
  | 'count'

/** The detail levels a reading tries, the fullest first, when it is larger than one answer may carry. */
const ROW_DETAILS: readonly RowDetail[] = ['full', 'summary', 'count']

/** One level of indentation inside the tree. */
const STEP = '  '

/**
 * What the model is told the call read.
 *
 * A reading that does not fit one answer keeps its dialog, its blocks, its
 * toolbar and its fields, gives up row detail in the order {@link ROW_DETAILS}
 * states, and says what it gave up; only a reading whose blocks and dialogs
 * alone are larger than an answer is cut, ending with a note saying how many
 * lines were left out.
 * @param reading - what the reading found.
 * @returns the report text, inside the reading's own bounds.
 */
export function readComponentReportText(reading: ComponentReading): string {
  let lines: string[] = []
  let cut = -1
  for (const detail of ROW_DETAILS) {
    lines = compose(reading, detail)
    cut = overflowAt(lines)
    if (cut === -1) return lines.join('\n')
  }
  return [...lines.slice(0, cut), truncationNote(lines.length - cut)].join('\n')
}

/**
 * The first line one answer has no room for, counting both bounds — lines and
 * characters — and reserving the truncation note's own line and characters, so
 * a reading cut there still fits.
 * @param lines - the composed lines.
 * @returns the index of that line, or -1 where every line fits.
 */
function overflowAt(lines: readonly string[]): number {
  let chars = 0
  return lines.findIndex((line, at) => {
    chars += line.length + 1
    return at >= MAX_READING_LINES - 1 || chars + NOTE_CHARS > MAX_READING_CHARS
  })
}

/**
 * The whole answer as lines, at one level of row detail.
 * @param reading - what the reading found.
 * @param detail - how much row detail to carry.
 * @returns the lines.
 */
function compose(reading: ComponentReading, detail: RowDetail): string[] {
  const lines = [`Read the component entry "${clip(reading.entry.title)}" (${reading.entry.id}).`]
  lines.push(reading.blockIds.length === 0 ? 'Blocks: none.' : `Blocks: ${reading.blockIds.join(', ')}.`)
  if (reading.missingNode !== undefined) lines.push(missingTargetReason(`block "${reading.missingNode}"`))
  for (const block of reading.blocks) {
    lines.push(`${STEP}- "${clip(block.node)}"`)
    lines.push(...scopeLines(block, 2, detail))
    for (const dialog of block.dialogs) lines.push(...dialogLines(dialog, 2, detail))
  }
  // A reading that failed to find the block it named describes nothing of the
  // entry's own drawing; the dialogs are still the entry's and are still said,
  // because what a model acts on next may be what is open in front.
  if (reading.missingNode !== undefined) {
    lines.push(...reading.outside.dialogs.flatMap(dialog => dialogLines(dialog, 0, detail)))
  } else {
    lines.push(...outsideLines(reading, reading.blocks.length === 0, detail))
  }
  if (!anyDialog(reading)) lines.push('No dialog is open.')
  return lines
}

/**
 * Whether the reading reports a dialog anywhere.
 * @param reading - what the reading found.
 * @returns whether one is open.
 */
function anyDialog(reading: ComponentReading): boolean {
  return reading.outside.dialogs.length > 0 || reading.blocks.some(block => block.dialogs.length > 0)
}

/**
 * The entry's own outside scope: bare at the top level where the entry draws no
 * block at all — there is nothing for a heading to stand outside of — and
 * under its own heading where blocks exist and something is drawn beside them.
 * @param reading - what the reading found.
 * @param bare - whether the reading describes no block.
 * @param detail - how much row detail to carry.
 * @returns the lines.
 */
function outsideLines(reading: ComponentReading, bare: boolean, detail: RowDetail): string[] {
  const outside = reading.outside
  const empty = outside.controls.length === 0 && outside.fields.length === 0
    && outside.rows === undefined && outside.dialogs.length === 0
  if (empty) return bare ? scopeLines(outside, 0, detail) : []
  if (bare) {
    return [
      ...scopeLines(outside, 0, detail),
      ...outside.dialogs.flatMap(dialog => dialogLines(dialog, 0, detail)),
    ]
  }
  return [
    'Outside every block:',
    ...scopeLines(outside, 1, detail),
    ...outside.dialogs.flatMap(dialog => dialogLines(dialog, 1, detail)),
  ]
}

/**
 * One scope's own contents: its controls, its fields and its folded rows.
 * @param scope - the scope the lines are for.
 * @param depth - how deep the scope's own headings stand.
 * @param detail - how much row detail to carry.
 * @returns the lines.
 */
function scopeLines(scope: ComponentReadScope, depth: number, detail: RowDetail): string[] {
  const at = STEP.repeat(depth)
  const inner = STEP.repeat(depth + 1)
  const lines = [`${at}Controls: none.`]
  if (scope.controls.length > 0) {
    lines[lines.length - 1] = `${at}Controls:`
    lines.push(...scope.controls.map(control => inner + controlLine(control)))
  }
  lines.push(`${at}Fields: none.`)
  if (scope.fields.length > 0) {
    lines[lines.length - 1] = `${at}Fields:`
    lines.push(...scope.fields.map(field => inner + fieldLine(field)))
  }
  if (scope.rows !== undefined) lines.push(...rowLines(scope.rows, depth, detail))
  return lines
}

/**
 * One open dialog as a tree node: its name, the block it stands in, and what it
 * draws, listed in full whatever detail the rows around it are given.
 * @param dialog - the dialog the reading found.
 * @param depth - how deep the node stands.
 * @param detail - how much row detail to carry.
 * @returns the lines.
 */
function dialogLines(dialog: ComponentReadDialog, depth: number, detail: RowDetail): string[] {
  const named = dialog.name === '' ? 'unnamed' : `"${clip(dialog.name)}"`
  const place = dialog.node === undefined ? '' : ` (in "${clip(dialog.node)}")`
  return [`${STEP.repeat(depth)}Dialog ${named}${place}:`, ...scopeLines(dialog, depth + 1, detail)]
}

/**
 * The folded rows of one scope, at one level of detail.
 *
 * The rows of a table are what makes one answer grow: a page of twenty records
 * is twenty rows of a dozen cells each, and every cell would be a line. So the
 * count is stated, what one row draws is counted by key rather than listed by
 * cell, and the rows themselves are named only up to {@link MAX_ROW_NAMES} —
 * and when the answer is still larger than one answer may carry, this is the
 * part that gives way, saying exactly how far.
 * @param rows - the folded rows.
 * @param depth - how deep the Rows line stands.
 * @param detail - how much detail to carry.
 * @returns the lines.
 */
function rowLines(rows: ComponentReadRows, depth: number, detail: RowDetail): string[] {
  const at = STEP.repeat(depth)
  const inner = STEP.repeat(depth + 1)
  const deeper = STEP.repeat(depth + 2)
  const counted = `${at}Rows: ${String(rows.drawn)} drawn${rows.total === undefined ? '' : ` (the page says "${clip(rows.total)}")`}.`
  if (detail === 'count') return [counted, `${inner}${droppedRows(rows.drawn)}`]
  const shared = rows.named[0]
  const lines = [counted]
  if (shared !== undefined && rows.named.every(row => sameDraws(row, shared))) {
    lines.push(`${inner}Each row draws:`)
    lines.push(...shared.draws.map(draw => `${deeper}- ${drawLine(draw)}`))
  } else {
    for (const row of rows.named) {
      lines.push(`${inner}- ${rowNameLine(row)}:`)
      lines.push(...row.draws.map(draw => `${deeper}- ${drawLine(draw)}`))
    }
  }
  if (detail === 'summary') {
    lines.push(`${inner}${droppedNames(rows.drawn)}`)
    return lines
  }
  lines.push(`${inner}Named rows:`)
  lines.push(...rows.named.map(row => `${deeper}- ${rowNameLine(row)}`))
  if (rows.drawn > rows.named.length) {
    lines.push(`${deeper}(${String(rows.drawn - rows.named.length)} more drawn rows are not named.)`)
  }
  return lines
}

/**
 * Whether two rows draw the same kinds of target, which is what lets one
 * `Each row draws:` stand for all of them.
 * @param row - the row.
 * @param against - the row it is compared with.
 * @returns whether their drawn kinds are the same.
 */
function sameDraws(row: ComponentReadRow, against: ComponentReadRow): boolean {
  if (row.draws.length !== against.draws.length) return false
  return row.draws.every((draw, at) => {
    const other = against.draws[at]
    return other !== undefined && draw.action === other.action && draw.ownKey === other.ownKey
      && draw.kind === other.kind && draw.count === other.count
  })
}

/**
 * What one drawn row is called on its own line.
 * @param row - the row.
 * @returns the name, quoted, or the word for a row that draws none.
 */
function rowNameLine(row: ComponentReadRow): string {
  return row.name === '' ? '(no words drawn)' : `"${clip(row.name)}"`
}

/**
 * One kind of target a row draws, as its counted set writes it.
 * @param draw - the kind.
 * @returns the phrase.
 */
function drawLine(draw: ComponentReadRow['draws'][number]): string {
  // The own key is said once: `keyOf` already names it for a kind of control
  // that carries no action of its own.
  const own = draw.action === undefined || draw.ownKey === undefined ? '' : `, own key "${clip(draw.ownKey)}"`
  return `${keyOf(draw)} ×${String(draw.count)}: ${draw.kind}${own}`
}

/**
 * The key a target answers to, as the reading names it.
 * @param target - the control or drawn kind.
 * @returns the key phrase.
 */
function keyOf(target: ComponentControlKeys): string {
  return target.action === undefined ? `own key "${clip(target.ownKey)}"` : `"${clip(target.action)}"`
}

/**
 * The sentence a reading ends its row section with when the names were given
 * up to fit one answer.
 * @param drawn - how many rows are drawn.
 * @returns the note.
 */
function droppedNames(drawn: number): string {
  return `(${String(drawn)} drawn rows are not named: the reading was cut to fit one answer.)`
}

/**
 * The sentence a reading ends its row section with when nothing but the count
 * is left of it.
 * @param drawn - how many rows are drawn.
 * @returns the note.
 */
function droppedRows(drawn: number): string {
  return `(${String(drawn)} drawn rows are not described: the reading was cut to fit one answer.)`
}

/**
 * One control as the reading writes it: the key a step names, what the control
 * is, what it says, and how far a step naming it would get.
 * @param control - the control the reading found.
 * @returns the line.
 */
function controlLine(control: ComponentReadControl): string {
  const key = keyOf(control)
  const own = control.action === undefined || control.ownKey === undefined ? '' : `, own key "${clip(control.ownKey)}"`
  const words = control.words === '' ? '' : ` "${clip(control.words)}"`
  return `- ${key}: ${control.kind}${words}${own}${stateNote(control.state)}`
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
  return `- "${clip(field.name)}": ${field.kind}${held}${stateNote(field.state)}`
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
    /* v8 ignore start -- ComponentTargetState is closed and every member returns above. */
    default: {
      // Not `assertNever` from dsh-llm, for the reason validate.ts states at its
      // own exhaustiveness check: this module is loaded by the browser seat.
      const unhandled: never = state
      throw new Error(`component-surface: unhandled target state ${JSON.stringify(unhandled)}`)
    }
    /* v8 ignore stop */
  }
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
