/**
 * The sentences `read_component` is described, refused, and reported with.
 *
 * The description is the tool's whole offer, so it states what the reading
 * answers and how a call addresses the entry it reads, and nothing about the
 * console's own layout. The refusals say only what stopped the call. The report
 * is the reading written out — the same facts, in the same names, a call acts
 * by — and it is composed here rather than in the console so the tree's shape
 * is written once, whatever composed the reading.
 *
 * The report is a tree rather than a listing: one node per block, one nested
 * node per open dialog, and the rows a scope draws folded to how many, what one
 * row draws and the first few names. That shape is what keeps one answer about
 * one page of records inside its budget: rows are the only part of a reading
 * that grows with the data, so they are the only part an oversized answer gives
 * up, and it says what it gave up rather than cutting itself off.
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
  type ComponentReadControl, type ComponentReadDialog, type ComponentReadField, type ComponentReadRow,
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
 * Composed here rather than in the console's own body so the tree's shape is
 * written once, and so a reading answered from a console that later version is
 * read the same way as one from this build. A reading that does not fit one
 * answer keeps its dialog, its blocks, its toolbar and its fields, gives up row
 * detail in the order {@link ROW_DETAILS} states, and says what it gave up; only
 * a reading whose very shape is larger than an answer is cut, with the note
 * saying how many lines were left out.
 * @param reading - what the reading found.
 * @returns the report text, inside the reading's own bounds.
 */
export function readComponentReportText(reading: ComponentReading): string {
  for (const detail of ROW_DETAILS) {
    const lines = compose(reading, detail)
    if (fits(lines)) return lines.join('\n')
  }
  return bounded(compose(reading, 'count'))
}

/**
 * Whether every composed line fits the bounds one answer is written to, the
 * truncation note's own line and characters included.
 * @param lines - the composed lines.
 * @returns whether they fit.
 */
function fits(lines: readonly string[]): boolean {
  let chars = 0
  for (const line of lines) {
    chars += line.length + 1
    if (chars + NOTE_CHARS > MAX_READING_CHARS) return false
  }
  return lines.length <= MAX_READING_LINES - 1
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
  const shared = rows.named.length === 0 ? undefined : rows.named[0]
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
function keyOf(target: { readonly action?: string; readonly ownKey?: string }): string {
  return target.action !== undefined
    ? `"${clip(target.action)}"`
    : `own key "${clip(target.ownKey ?? '')}"`
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
    /* v8 ignore next 2 -- the state union is closed and typed; the arm keeps a new state loud */
    default: return ''
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

/**
 * Cut a reading to what one answer may carry, saying so where it was cut.
 *
 * The outer bound, reached only by a reading whose own shape — blocks, dialogs,
 * toolbars and fields, which no size gives up — is larger than one answer; a
 * reading that rows alone made too large was reduced in
 * {@link readComponentReportText} before it came here. Two bounds, a count and
 * a size, and both are held by the same walk: a wide entry draws many short
 * lines and a narrow one may draw a few long ones. The note's own line and its
 * own characters are reserved rather than added, so a cut reading is still
 * inside the bound it was cut for.
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
  /* v8 ignore next -- the walk is entered only with lines that already missed fits(), so it cuts before the last one */
  return kept.join('\n')
}
