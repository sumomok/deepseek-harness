/**
 * `act_component`'s own vocabulary: the tool's arguments, the answer it settles
 * on, and the readers both of this package's channel tools share — the events
 * a call arrives in, the id one settles by, and the report fields.
 *
 * Arguments use the components' own names rather than DOM references: `node`
 * is the block id `show_component`'s spec declared, `key` an action key a
 * component declares or a control's own key, and `name` the column or property
 * a field is named by.
 * The host and the browser parse with the same readers, so neither accepts what
 * the other refuses.
 * @module @deepseek-ai/dsh-experimental-component-surface/act-component-call
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  ActOutcome, ActStepResult, ChannelOutcome, ChannelReportRequest,
} from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'
// Type-only: that module imports this one's readers as values.
import type { ReadComponentCall } from './read-component-call.ts'
import { MAX_ACT_COMPONENT_STEPS, MAX_CHANNEL_ID_CHARS, MAX_ENTRY_ID_LENGTH, TOKEN_CHARSET } from './component-call.ts'

// Owned by component-call.ts, whose action document's step mark is bounded by
// them, and named here as well because they are this tool's own ceilings.
export { MAX_ACT_COMPONENT_STEPS, MAX_CHANNEL_ID_CHARS } from './component-call.ts'

/** Longest a report's own message or one step's sentence may be. */
export const MAX_MESSAGE_CHARS = 512

/** Longest a report's own text may be. */
export const MAX_REPORT_TEXT_CHARS = 20_000

/** Longest an entry title a report names may be. */
export const MAX_TITLE_CHARS = 200

/** The tool this channel serves. */
export const ACT_COMPONENT_TOOL_NAME = 'act_component'

/** Longest a named block, key, or field name may be. */
export const MAX_TARGET_CHARS = 64

/** Longest a value written into a field may be. */
export const MAX_SET_VALUE_CHARS = 4096

/** How long a `wait` step waits for its block or key when the call names no other. */
export const DEFAULT_WAIT_MS = 2000

/** Longest a `wait` step may wait, whatever the call asks for. */
export const MAX_WAIT_MS = 10_000

/** The three actions a step may be. */
export const ACT_COMPONENT_ACTIONS = ['click', 'set', 'wait'] as const

/** Press the control one block declares under one key. */
export interface ActComponentClick {
  /** Discriminant. */
  readonly action: 'click'
  /** The block the control belongs to; the whole entry when absent. */
  readonly node?: string
  /**
   * The action key the component declares for that control, or the control's
   * own key where several drawn controls share that action.
   */
  readonly key: string
}

/** Write one value into the field the entry names for one column or property. */
export interface ActComponentSet {
  /** Discriminant. */
  readonly action: 'set'
  /** The block the field belongs to; the whole entry when absent. */
  readonly node?: string
  /** The column or property the field is named by. */
  readonly name: string
  /** What to write into it. */
  readonly value: string
}

/** Wait for one block or one declared control to be drawn: a step names the block, the key, or both. */
export type ActComponentWait = {
  /** Discriminant. */
  readonly action: 'wait'
  /** How long to wait, in milliseconds; {@link DEFAULT_WAIT_MS} when absent. */
  readonly timeoutMs?: number
} & (
  | {
    /** The block to wait for, or to wait in for the key. */
    readonly node: string
    /** The action key, or a control's own key, to wait for. */
    readonly key?: string
  }
  | {
    /** No block: the key is waited for anywhere in the entry. */
    readonly node?: undefined
    /** The action key, or a control's own key, to wait for. */
    readonly key: string
  }
)

/** One step of one `act_component` call. */
export type ActComponentStep = ActComponentClick | ActComponentSet | ActComponentWait

/** What one call asks of the entry it names. */
export interface ActComponentArgs {
  /** The content-column entry the call is against, as `show_component` placed it. */
  readonly entry: string
  /** The steps, in the order they run. */
  readonly steps: readonly ActComponentStep[]
}

/**
 * How one step ended, in the shared channel's own vocabulary: only the step
 * that stopped the call carries a message.
 */
export type ActComponentStepResult = ActStepResult

/**
 * What a claimed call answers with when the entry was there, in the shared
 * channel's own fields; `page` names the component entry.
 */
export type ActComponentReport = ActOutcome

/** What one claimed `act_component` call ends as, as the shared channel carries it. */
export type ActComponentOutcome = ChannelOutcome

/** One open `act_component` call, as the projection publishes it to a browser. */
export interface ActComponentCall {
  /** The call to claim and report against. */
  readonly callId: string
  /** The tool that asked. */
  readonly tool: 'act_component'
  /** What the call asked of the entry. */
  readonly args: ActComponentArgs
}

/** One open call of this package's channel; `tool` tells which of its tools opened it. */
export type ComponentCall = ActComponentCall | ReadComponentCall

/** Whole current value of the projection this package publishes for its own calls. */
export interface ComponentView {
  /** Every open call, oldest first. */
  readonly pending: readonly ComponentCall[]
  /**
   * How long the tab that claims an `act_component` call may spend running its
   * steps, in milliseconds from when it starts: a share of the host's report
   * deadline, leaving the rest for the claim and report to travel.
   */
  readonly stepBudgetMs: number
}

/** The name both of this package's tools register under on the shared content channel, used in its diagnostics only. */
export const COMPONENT_DOMAIN = 'component'

/**
 * Whether one settled call's outcome reports steps that ran.
 * @param outcome - what the call settled as.
 * @returns whether it reports steps rather than a refusal to run any.
 */
export function isActComponentReport(outcome: ActComponentOutcome): outcome is ActComponentReport {
  return outcome.status === 'done' || outcome.status === 'failed'
}

/**
 * Whether one decoded value is a target name the components' own alphabet
 * admits: a block, a key, or a field name, which both of this package's tools
 * address their calls by.
 * @param value - the decoded value, however malformed.
 * @returns whether it is such a name.
 */
export function isTarget(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TARGET_CHARS && TOKEN_CHARSET.test(value)
}

/**
 * Whether one decoded value is a non-empty name inside a bound.
 * @param value - the decoded value, however malformed.
 * @param max - the longest the name may be.
 * @returns whether it is such a name.
 */
export function isName(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/**
 * Whether one decoded value is a text field inside a bound.
 * @param value - the decoded value, however malformed.
 * @param max - the longest the text may be.
 * @returns whether it is such a text.
 */
export function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/**
 * Whether one decoded value is an entry id either tool of this package may name.
 * @param value - the decoded value, however malformed.
 * @returns whether it is such an id.
 */
export function isEntryId(value: unknown): value is string {
  return isName(value, MAX_ENTRY_ID_LENGTH)
}

/**
 * A field one step carries that names a target or a value its action does not
 * take: `name` or `value` on a `click` or a `wait`, and `key` on a `set`.
 */
export type IgnoredStepField =
  | {
    /** The action that takes no such field. */
    readonly action: 'click' | 'wait'
    /** The field it carried. */
    readonly field: 'name' | 'value'
  }
  | {
    /** The action that takes no such field. */
    readonly action: 'set'
    /** The field it carried. */
    readonly field: 'key'
  }

/**
 * Find the field one step carries that would name a target or a value its
 * action does not take. A step carrying one is refused whole: the field shows
 * the call meant a control or a value that no step of that action reaches.
 * `timeoutMs` on a `click` or a `set` is not such a field, since it bounds time
 * rather than choosing a control, and the reader drops it. The host's argument
 * check and {@link readActComponentStep} both ask this.
 * @param value - the step, however malformed.
 * @returns the action and the field it does not take, or `undefined` when the
 *   step carries none or names no action this tool runs.
 */
export function ignoredStepField(value: unknown): IgnoredStepField | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const step = value as { action?: unknown; key?: unknown; name?: unknown; value?: unknown }
  switch (step.action) {
    case 'click':
    case 'wait':
      if (step.name !== undefined) return { action: step.action, field: 'name' }
      return step.value === undefined ? undefined : { action: step.action, field: 'value' }
    case 'set': return step.key === undefined ? undefined : { action: 'set', field: 'key' }
    // `action` is whatever the model sent.
    default: return undefined
  }
}

/**
 * Read one step from a decoded value.
 * @param value - the step, however malformed.
 * @returns the step, or `undefined` when the value is not one this tool runs,
 *   including a step carrying an {@link ignoredStepField}.
 */
export function readActComponentStep(value: unknown): ActComponentStep | undefined {
  if (value === null || typeof value !== 'object') return undefined
  if (ignoredStepField(value) !== undefined) return undefined
  const step = value as {
    action?: unknown
    node?: unknown
    key?: unknown
    name?: unknown
    value?: unknown
    timeoutMs?: unknown
  }
  const { node, key } = step
  if (node !== undefined && !isTarget(node)) return undefined
  const block = node === undefined ? {} : { node }
  switch (step.action) {
    case 'click': return isTarget(key) ? { action: 'click', ...block, key } : undefined
    case 'set':
      return isTarget(step.name) && typeof step.value === 'string' && step.value.length <= MAX_SET_VALUE_CHARS
        ? { action: 'set', ...block, name: step.name, value: step.value }
        : undefined
    case 'wait': return readWait(node, key, step.timeoutMs)
    // `action` is whatever the model sent.
    default: return undefined
  }
}

/**
 * Read one `wait` step: a block, a key, or both, and a duration inside the ceiling.
 * @param node - the block the step named, already read as a target.
 * @param key - the key the step named, however malformed.
 * @param timeoutMs - the duration the step named, however malformed.
 * @returns the step, or `undefined` when it names neither target or a malformed one.
 */
function readWait(node: string | undefined, key: unknown, timeoutMs: unknown): ActComponentWait | undefined {
  if (key !== undefined && !isTarget(key)) return undefined
  if (timeoutMs !== undefined
    && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS)) {
    return undefined
  }
  const duration = timeoutMs === undefined ? {} : { timeoutMs }
  if (node !== undefined) return { action: 'wait', node, ...key === undefined ? {} : { key }, ...duration }
  return key === undefined ? undefined : { action: 'wait', key, ...duration }
}

/**
 * Read one call's arguments from a decoded value; one unreadable step makes the
 * whole call unreadable.
 * @param value - the decoded arguments, however malformed.
 * @returns the arguments, or `undefined` when the value is not a runnable set.
 */
export function parseActComponentArgs(value: unknown): ActComponentArgs | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { entry?: unknown; steps?: unknown }
  if (!isEntryId(candidate.entry)) return undefined
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0 || candidate.steps.length > MAX_ACT_COMPONENT_STEPS) return undefined
  const steps: ActComponentStep[] = []
  for (const raw of candidate.steps) {
    const step = readActComponentStep(raw)
    if (step === undefined) return undefined
    steps.push(step)
  }
  return { entry: candidate.entry, steps }
}

/**
 * Read the entry one posted outcome names: its id, and the title the column shows for it.
 * @param value - the decoded `page` field, however malformed.
 * @returns the entry, or `undefined` when the value is not one.
 */
export function readReportedEntry(value: unknown): { id: string; title: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const named = value as { id?: unknown; title?: unknown }
  return isEntryId(named.id) && isText(named.title, MAX_TITLE_CHARS) ? { id: named.id, title: named.title } : undefined
}

/**
 * Read one posted `act_component` outcome. The document crossed a process, so
 * every field is checked and every string bounded before the host carries it
 * to the model.
 * @param value - the decoded `outcome` field, however malformed.
 * @returns the outcome, or `undefined` when the value is not one this tool posts.
 */
export function parseActComponentOutcome(value: unknown): ChannelOutcome | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const outcome = value as {
    status?: unknown
    page?: unknown
    title?: unknown
    steps?: unknown
    text?: unknown
    truncated?: unknown
    code?: unknown
    message?: unknown
  }
  if (outcome.status === 'error') {
    // `empty`: no component entry in front; `front-changed`: another one is;
    // `engine`: the steps threw.
    if (outcome.code !== 'empty' && outcome.code !== 'front-changed' && outcome.code !== 'engine') return undefined
    if (!isText(outcome.message, MAX_MESSAGE_CHARS)) return undefined
    return { status: 'error', code: outcome.code, message: outcome.message }
  }
  if (outcome.status !== 'done' && outcome.status !== 'failed') return undefined
  const page = readReportedEntry(outcome.page)
  if (page === undefined) return undefined
  if (!isText(outcome.title, MAX_TITLE_CHARS)) return undefined
  if (typeof outcome.truncated !== 'boolean') return undefined
  if (!Array.isArray(outcome.steps) || outcome.steps.length > MAX_ACT_COMPONENT_STEPS) return undefined
  if (!outcome.steps.every(isStepResult)) return undefined
  if (!isText(outcome.text, MAX_REPORT_TEXT_CHARS)) return undefined
  return {
    status: outcome.status,
    page,
    title: outcome.title,
    steps: outcome.steps,
    text: outcome.text,
    truncated: outcome.truncated,
  }
}

/** Whether one decoded value is a step result the host may carry to the model. */
function isStepResult(value: unknown): value is ActComponentStepResult {
  if (value === null || typeof value !== 'object') return false
  const step = value as { index?: unknown; status?: unknown; message?: unknown }
  if (typeof step.index !== 'number' || !Number.isInteger(step.index) || step.index < 1) return false
  if (step.status === 'failed') return isText(step.message, MAX_MESSAGE_CHARS)
  if (step.status !== 'ok' && step.status !== 'skipped') return false
  return step.message === undefined
}

/**
 * Read one posted report of either tool of this package: the call and tab ids
 * bounded by {@link MAX_CHANNEL_ID_CHARS}, the outcome by the tool's own reader.
 * @param body - the decoded request body, however malformed.
 * @param parseOutcome - the tool's own reading of the `outcome` field.
 * @returns the report, or `undefined` when the body is not one.
 */
export function readChannelReport(
  body: unknown,
  parseOutcome: (value: unknown) => ChannelOutcome | undefined,
): ChannelReportRequest | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const candidate = body as { callId?: unknown; tabId?: unknown; outcome?: unknown }
  if (!isName(candidate.callId, MAX_CHANNEL_ID_CHARS) || !isName(candidate.tabId, MAX_CHANNEL_ID_CHARS)) return undefined
  const outcome = parseOutcome(candidate.outcome)
  return outcome === undefined ? undefined : { callId: candidate.callId, tabId: candidate.tabId, outcome }
}

/**
 * Read one posted `act_component` report.
 * @param body - the decoded request body, however malformed.
 * @returns the report, or `undefined` when the body is not one.
 */
export function parseActComponentReport(body: unknown): ChannelReportRequest | undefined {
  return readChannelReport(body, parseActComponentOutcome)
}

/**
 * Read one tool call of this package's channel out of a committed `tool/call`
 * or `tool/ptc-dispatch-start` event. The name is compared before the
 * arguments are parsed, since the fold runs over every event of every session.
 * @param event - the committed session event.
 * @param tool - the tool name this reading takes.
 * @param parse - that tool's own reading of its arguments.
 * @returns the call id and the arguments, or `undefined` when the event opens no call of this tool.
 */
export function readChannelToolCall<Args>(
  event: SessionEvent,
  tool: string,
  parse: (value: unknown) => Args | undefined,
): { callId: string; args: Args } | undefined {
  if (event.type === 'tool/call') {
    if (event.data.name !== tool) return undefined
    let decoded: unknown
    try {
      decoded = JSON.parse(event.data.arguments)
    } catch (_argumentsAreNotJson) {
      // A model can emit anything as arguments; the tool refuses the same call.
      return undefined
    }
    const args = parse(decoded)
    return args === undefined ? undefined : { callId: event.data.callId, args }
  }
  if (event.type === 'tool/ptc-dispatch-start') {
    if (event.data.name !== tool) return undefined
    const args = parse(event.data.arguments)
    return args === undefined ? undefined : { callId: event.data.subCallId, args }
  }
  return undefined
}

/**
 * Read the call one committed event opened.
 * @param event - the committed session event.
 * @returns the call, or `undefined` when the event opens no usable one.
 */
export function readActComponentCall(event: SessionEvent): ActComponentCall | undefined {
  const opened = readChannelToolCall(event, ACT_COMPONENT_TOOL_NAME, parseActComponentArgs)
  return opened === undefined ? undefined : { callId: opened.callId, tool: ACT_COMPONENT_TOOL_NAME, args: opened.args }
}

/**
 * The call id one committed event closes.
 *
 * The result events carry no tool name, so the id is matched against the open
 * list instead: an id that is not in it removes nothing.
 * @param event - the committed session event.
 * @returns the settled call id, or `undefined` when the event settles none.
 */
export function settledComponentCall(event: SessionEvent): string | undefined {
  if (event.type === 'tool/result') return event.data.message.source.callId
  if (event.type === 'tool/ptc-dispatch') return event.data.subCallId
  return undefined
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    componentAccess: ComponentCall[]
  }
  interface SessionProjectionMap {
    /**
     * The calls of this package's tools one session has open, in log order:
     * how the host asks the tab showing the session to act inside or read a
     * component entry.
     */
    componentAccess: ComponentView
  }
}
