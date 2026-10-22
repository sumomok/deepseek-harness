/**
 * `read_component`'s own vocabulary: the tool's arguments, the reading the
 * console composes and the text module writes out, and the parsers the host
 * and the browser share, so neither accepts what the other refuses.
 * @module @deepseek-ai/dsh-experimental-component-surface/read-component-call
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChannelReportRequest, ComponentReadOutcome } from '@deepseek-ai/dsh-experimental-content-frame/access/wire'
import {
  isEntryId, isTarget, isText, parseActComponentReport, readChannelReport, readChannelToolCall, readReportedEntry,
} from './act-component-call.ts'

/** The tool this reading serves. */
export const READ_COMPONENT_TOOL_NAME = 'read_component'

/**
 * Most lines one reading may carry, the truncation note included. A protocol
 * ceiling: a reading over it drops row detail first, then cuts lines and says
 * how many it left out.
 */
export const MAX_READING_LINES = 200

/** Most characters one reading may carry, the truncation note included. */
export const MAX_READING_CHARS = 10_000

/**
 * Longest any one run of drawn words, one key, one name or one value is printed
 * to, with an ellipsis where it was longer.
 */
export const MAX_READING_TEXT_CHARS = 120

/** Most drawn rows one reading names; the rest are counted. */
export const MAX_ROW_NAMES = 20

/** What one `read_component` call asks of the entry it names. */
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

/** The keys one control answers to, as the block marks it: an action key, its own key, or both. */
export type ComponentControlKeys =
  | {
    /** The action key the block declares for the control. */
    readonly action: string
    /** The control's own key, where the block declares one for it. */
    readonly ownKey?: string
  }
  | {
    /** No action key: the control carries only its own key. */
    readonly action?: never
    /** The control's own key. */
    readonly ownKey: string
  }

/** One control the reading found drawn, addressable the way a step addresses it. */
export type ComponentReadControl = ComponentControlKeys & {
  /** What the control is, in the platform's own word for it: `button`, `textbox`, … */
  readonly kind: string
  /** What the control says about itself: the words it draws, or the name it carries; empty when it draws neither. */
  readonly words: string
  /** How a step naming it would find it. */
  readonly state: ComponentTargetState
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
}

/**
 * One kind of target a drawn row holds, counted rather than listed: controls
 * with the same keys and kind are one kind.
 */
export type ComponentReadRowDraw = ComponentControlKeys & {
  /** What the control is, in the platform's own word for it. */
  readonly kind: string
  /** How many of them the row draws. */
  readonly count: number
}

/** One drawn row, as much of it as a reading reports. */
export interface ComponentReadRow {
  /** What the row is called: the words of its first drawn target that draws any; empty where none does. */
  readonly name: string
  /**
   * The key a `click` step's `row` names the row by: the one row key every
   * control the row draws is marked with, where that key is one a step can
   * carry; absent otherwise.
   */
  readonly key?: string
  /** The kinds of target the row draws, in the order the row draws them. */
  readonly draws: readonly ComponentReadRowDraw[]
}

/** The rows one scope draws, folded: how many, what each draws, and the first few named. */
export interface ComponentReadRows {
  /** How many rows the scope draws. */
  readonly drawn: number
  /** The page's own words for how many records its query matched, where the scope draws a count of its own. */
  readonly total?: string
  /** The first {@link MAX_ROW_NAMES} drawn rows, in the order drawn. */
  readonly named: readonly ComponentReadRow[]
}

/** What one scope — a block, an open dialog, or the entry outside every block — draws itself. */
export interface ComponentReadScope {
  /** The controls the scope draws itself, outside its rows and outside any dialog of its own. */
  readonly controls: readonly ComponentReadControl[]
  /** The fields the scope draws itself, with what each is drawn with. */
  readonly fields: readonly ComponentReadField[]
  /** The rows the scope draws, present only where it draws any. */
  readonly rows?: ComponentReadRows
}

/** One open dialog a reading found, with what it draws. */
export interface ComponentReadDialog extends ComponentReadScope {
  /** The name the dialog draws for itself; empty where it declares none. */
  readonly name: string
  /** The block the dialog is drawn in; absent for one drawn outside every block. */
  readonly node?: string
}

/** One block the entry draws, with what it draws and the dialogs open inside it. */
export interface ComponentReadBlock extends ComponentReadScope {
  /** The id the placement wrote for the block. */
  readonly node: string
  /** The dialogs open inside the block, outermost first. */
  readonly dialogs: readonly ComponentReadDialog[]
}

/** What the entry draws outside every block: its own targets, and the dialogs open there. */
export interface ComponentReadOutside extends ComponentReadScope {
  /** The dialogs open outside every block, outermost first. */
  readonly dialogs: readonly ComponentReadDialog[]
}

/** What one reading found inside the entry, as the tree the text module writes out. */
export interface ComponentReading {
  /** The entry the column had in front. */
  readonly entry: { readonly id: string; readonly title: string }
  /** The node ids of the blocks drawn, in document order, whether or not the reading describes them. */
  readonly blockIds: readonly string[]
  /** The blocks the reading describes, in document order, each with what it draws. */
  readonly blocks: readonly ComponentReadBlock[]
  /** What the entry draws outside every block. */
  readonly outside: ComponentReadOutside
  /** The node the call narrowed the reading to, present only when the entry does not draw it. */
  readonly missingNode?: string
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

/**
 * Read one call's arguments from a decoded value.
 * @param value - the decoded arguments, however malformed.
 * @returns the arguments, or `undefined` when the value is not a readable set.
 */
export function parseReadComponentArgs(value: unknown): ReadComponentArgs | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { entry?: unknown; node?: unknown }
  if (!isEntryId(candidate.entry)) return undefined
  if (candidate.node !== undefined && !isTarget(candidate.node)) return undefined
  return { entry: candidate.entry, ...candidate.node === undefined ? {} : { node: candidate.node } }
}

/**
 * Read the `read_component` call one committed event opened.
 * @param event - the committed session event.
 * @returns the call, or `undefined` when the event opens no usable one.
 */
export function readReadComponentCall(event: SessionEvent): ReadComponentCall | undefined {
  const opened = readChannelToolCall(event, READ_COMPONENT_TOOL_NAME, parseReadComponentArgs)
  return opened === undefined ? undefined : { callId: opened.callId, tool: READ_COMPONENT_TOOL_NAME, args: opened.args }
}

/**
 * Read one posted component reading. The document crossed a process, so every
 * field is checked and every string bounded before the host carries it to the
 * model.
 * @param value - the decoded `outcome` field, however malformed.
 * @returns the outcome, or `undefined` when the value is not one this tool posts.
 */
export function parseReadComponentOutcome(value: unknown): ComponentReadOutcome | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const outcome = value as { status?: unknown; page?: unknown; text?: unknown }
  if (outcome.status !== 'read') return undefined
  const page = readReportedEntry(outcome.page)
  if (page === undefined || !isText(outcome.text, MAX_READING_CHARS)) return undefined
  return { status: 'read', page, text: outcome.text }
}

/**
 * Read one posted `read_component` report.
 * @param body - the decoded request body, however malformed.
 * @returns the report, or `undefined` when the body is not one.
 */
export function parseReadComponentReport(body: unknown): ChannelReportRequest | undefined {
  return readChannelReport(body, parseReadComponentOutcome)
}

/**
 * Read one posted report of either tool this package's channel serves. Each
 * tool's reading refuses the other's document, and the shared refusal arm is
 * read by `act_component`'s.
 * @param body - the decoded request body, however malformed.
 * @returns the report, or `undefined` when no tool of this package posts it.
 */
export function parseComponentReport(body: unknown): ChannelReportRequest | undefined {
  return parseActComponentReport(body) ?? parseReadComponentReport(body)
}
