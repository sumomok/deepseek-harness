/**
 * `read_component`'s own vocabulary: the tool's arguments, the reading it
 * settles on, and the readers both halves of the package share.
 *
 * The arguments address the same things `act_component`'s do, in the same
 * language: which entry, and which block of it the reading is narrowed to. The
 * reading itself is stated here as well — one block per id the placement wrote,
 * one control per mark a step could name, one field per name the entry gives —
 * because the console composes it and the text module writes it out, and the
 * two halves meet on this shape.
 *
 * Parsing lives beside the types for the reason `act-component-call.ts` states:
 * the host judges a call with the same reading the browser runs, so neither half
 * can accept what the other refuses.
 * @module @deepseek-ai/dsh-experimental-component-surface/read-component-call
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Type-only: the shared channel's own outcome vocabulary, which every content
// domain settles its calls with.
import type { ChannelReportRequest, ComponentReadOutcome } from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'
import {
  isTarget, MAX_CHANNEL_ID_CHARS, MAX_TITLE_CHARS, parseActComponentReport, readChannelToolCall,
} from './act-component-call.ts'
import { MAX_ENTRY_ID_LENGTH } from './component-call.ts'

/** The tool this reading serves. */
export const READ_COMPONENT_TOOL_NAME = 'read_component'

/**
 * Most lines one reading may carry, the truncation note included.
 *
 * A protocol ceiling rather than a deployment choice: a reading is bounded so a
 * table of hundreds of rows cannot fill a request with the model's own panel,
 * and the note a cut reading ends with says how much was left out. A model that
 * needs more narrows the reading to one block.
 */
export const MAX_READING_LINES = 200

/**
 * Most characters one reading may carry, the truncation note included. The
 * second bound of the same kind, because lines of a table's operation links are
 * short enough that a count alone would not bound the text.
 */
export const MAX_READING_CHARS = 10_000

/**
 * Longest any one run of drawn words, one key, one name or one value is printed
 * to, with an ellipsis where it was longer.
 */
export const MAX_READING_TEXT_CHARS = 120

/**
 * What one `read_component` call asks of the entry it names.
 *
 * `node` narrows the reading to one block, by the id the placement wrote, the
 * same name a `set` or `click` step would confine itself to; a call that names
 * none reads the whole entry.
 */
export interface ReadComponentArgs {
  /** The content-column entry the call is against, as the entry was placed. */
  readonly entry: string
  /** The block the reading is narrowed to; the whole entry when absent. */
  readonly node?: string
}

/** Where one control or field stands for the person using the entry. */
export type ComponentTargetState =
  /** A person could use it as it is drawn. */
  | 'reachable'
  /** The block has disabled it, and no click would run its handler. */
  | 'disabled'
  /** Something else is drawn over the point it occupies. */
  | 'covered'

/** One control the reading found drawn, addressable the way a step addresses it. */
export interface ComponentReadControl {
  /** The action key the block declares for the control; absent for one carrying only its own key. */
  readonly action?: string
  /** The control's own key, where the block declares one for it. */
  readonly ownKey?: string
  /** What the control is, in the platform's own word for it: `button`, `textbox`, … */
  readonly kind: string
  /** What the control says about itself: the words it draws, or the name it carries; empty when it draws neither. */
  readonly words: string
  /** How a step naming it would find it. */
  readonly state: ComponentTargetState
  /** The block that drew it; absent for a control drawn outside every block. */
  readonly node?: string
  /** The open dialog it is drawn inside; absent when it is drawn outside one. */
  readonly dialog?: string
}

/** One field the reading found drawn, with what it currently holds. */
export interface ComponentReadField {
  /** The column or property the entry names the field by, which is what a `set` step writes. */
  readonly name: string
  /** What the control is, in the platform's own word for it. */
  readonly kind: string
  /** The value it is drawn with; absent for a field that carries no text value. */
  readonly value?: string
  /** Whether it is ticked, for a field that carries a tick; absent for one that does not. */
  readonly checked?: boolean
  /** True for a value the reading refuses to print, like a password field's. */
  readonly secret?: boolean
  /** How a step naming it would find it. */
  readonly state: ComponentTargetState
  /** The block that drew it; absent for a field drawn outside every block. */
  readonly node?: string
  /** The open dialog it is drawn inside; absent when it is drawn outside one. */
  readonly dialog?: string
}

/** What one reading found inside the entry, before the text module writes it out. */
export interface ComponentReading {
  /** The entry the column had in front. */
  readonly entry: { readonly id: string; readonly title: string }
  /** The node ids of the blocks drawn, in document order. */
  readonly blocks: readonly string[]
  /** The node the call narrowed the reading to, present only when the entry does not draw it. */
  readonly missingNode?: string
  /** The controls drawn, in document order. */
  readonly controls: readonly ComponentReadControl[]
  /** The fields the entry names, with what each is drawn with, in document order. */
  readonly fields: readonly ComponentReadField[]
  /** The names the open dialogs draw for themselves, outermost first, empty-valued where one draws none. */
  readonly dialogs: readonly string[]
}

/** One open `read_component` call, as the projection publishes it to a browser. */
export interface ReadComponentCall {
  /** The call to claim and report against. */
  readonly callId: string
  /** The tool that asked. */
  readonly tool: 'read_component'
  /** What the call asked of the entry. */
  readonly args: ReadComponentArgs
}

/** Whether one decoded value is a non-empty name inside a bound. */
function isName(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/** Whether one decoded value is a text field inside a bound. */
function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/**
 * Read one call's arguments from a decoded value.
 *
 * A field this reading does not take makes the whole call unreadable rather
 * than partially understood: the tool's own schema refuses that call too, so a
 * browser told to read half of it would be reading something nobody asked for.
 * @param value - the decoded arguments, however malformed.
 * @returns the arguments, or `undefined` when the value is not a readable set.
 */
export function parseReadComponentArgs(value: unknown): ReadComponentArgs | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { entry?: unknown; node?: unknown }
  if (!isName(candidate.entry, MAX_ENTRY_ID_LENGTH)) return undefined
  if (candidate.node !== undefined && !isTarget(candidate.node)) return undefined
  return { entry: candidate.entry, ...candidate.node === undefined ? {} : { node: candidate.node } }
}

/**
 * Read the call one committed event opened.
 *
 * The log shapes and the settle test are the ones both of this package's tools
 * are read by, declared once beside `act_component`'s reading; this is the same
 * reading under this tool's own name.
 * @param event - the committed session event.
 * @returns the call, or `undefined` when the event opens no usable one.
 */
export function readReadComponentCall(event: SessionEvent): ReadComponentCall | undefined {
  const opened = readChannelToolCall(event, READ_COMPONENT_TOOL_NAME, parseReadComponentArgs)
  return opened === undefined ? undefined : { callId: opened.callId, tool: READ_COMPONENT_TOOL_NAME, args: opened.args }
}

/**
 * Read one posted component reading.
 *
 * A wire boundary: the document crossed a process, so its own contract is
 * checked here rather than trusted from the type. Every string carries a bound
 * of its own, so a forged report cannot make the host carry an arbitrary
 * document to the model.
 *
 * The result is the shared channel's own vocabulary rather than a type of this
 * package's, for the reason `act-component-call.ts` states: the member that
 * reads a report hands it to the waiting tool through the channel, and a second
 * spelling of the same document would be one more place for the two to
 * disagree.
 * @param value - the decoded `outcome` field, however malformed.
 * @returns the outcome, or `undefined` when the value is not one this tool posts.
 */
export function parseReadComponentOutcome(value: unknown): ComponentReadOutcome | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const outcome = value as { status?: unknown; page?: unknown; text?: unknown }
  if (outcome.status !== 'read') return undefined
  const page = outcome.page
  if (page === null || typeof page !== 'object') return undefined
  const named = page as { id?: unknown; title?: unknown }
  if (!isName(named.id, MAX_ENTRY_ID_LENGTH) || !isText(named.title, MAX_TITLE_CHARS)) return undefined
  if (!isText(outcome.text, MAX_READING_CHARS)) return undefined
  return { status: 'read', page: { id: named.id, title: named.title }, text: outcome.text }
}

/**
 * Read one posted `read_component` report.
 *
 * A wire boundary like {@link parseReadComponentOutcome}: the call and the tab
 * are read as names at {@link MAX_CHANNEL_ID_CHARS}, the bound the page domain
 * takes the same two ids at, and the outcome carries its own bounds.
 * @param body - the decoded request body, however malformed.
 * @returns the report, or `undefined` when the body is not one.
 */
export function parseReadComponentReport(body: unknown): ChannelReportRequest | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const candidate = body as { callId?: unknown; tabId?: unknown; outcome?: unknown }
  if (!isName(candidate.callId, MAX_CHANNEL_ID_CHARS) || !isName(candidate.tabId, MAX_CHANNEL_ID_CHARS)) return undefined
  const outcome = parseReadComponentOutcome(candidate.outcome)
  return outcome === undefined ? undefined : { callId: candidate.callId, tabId: candidate.tabId, outcome }
}

/**
 * Read one posted report of either tool this package's channel serves.
 *
 * One member reads both tools' reports, because both open their calls through
 * one registration: the arm is told apart by its own discriminant, and each
 * tool's reading refuses the other's document. The refusal arm is shared —
 * `empty`, `front-changed` and `engine` say the same three things to either
 * tool — and is read by `act_component`'s reading, which both settle through.
 * @param body - the decoded request body, however malformed.
 * @returns the report, or `undefined` when no tool of this package posts it.
 */
export function parseComponentReport(body: unknown): ChannelReportRequest | undefined {
  return parseActComponentReport(body) ?? parseReadComponentReport(body)
}
