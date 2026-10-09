/**
 * `act_component`'s own vocabulary: the tool's arguments, the answer it settles
 * on, and the readers both halves of the package share.
 *
 * The arguments are addressed in the components' own language rather than in
 * DOM references: which entry, which block of it, and which control or field the
 * call names, all as the placement wrote them. That is what makes a call
 * replayable and readable — `node` is the id `show_component`'s spec declared,
 * `key` is the action key the component declares for one of its controls, and
 * `name` is the column or property a field is named by.
 *
 * Parsing lives beside the types for the reason `component-call.ts` states: the
 * host judges a call with the same reading the browser runs, so neither half can
 * accept what the other refuses.
 * @module @deepseek-ai/dsh-experimental-component-surface/act-component-call
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Type-only: the shared channel's own outcome vocabulary, which both content
// domains settle their calls with.
import type {
  ActOutcome, ActStepResult, ChannelOutcome, ChannelReportRequest,
} from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'
import { MAX_ENTRY_ID_LENGTH, TOKEN_CHARSET } from './component-call.ts'

/** Longest a report's own message or one step's sentence may be. */
export const MAX_MESSAGE_CHARS = 512

/** Longest a report's own text may be. */
export const MAX_REPORT_TEXT_CHARS = 20_000

/** Longest an entry title a report names may be. */
export const MAX_TITLE_CHARS = 200

/**
 * Longest call or tab id a posted report may name, in characters.
 *
 * The same bound the page domain's own report reader takes those two ids at
 * (`MAX_NAME_CHARS` in content-frame's `access/wire.ts`): one channel carries
 * both domains' posts, and the ids are minted by the host rather than by either
 * domain, so a domain that bounded them more tightly would refuse a report the
 * other takes — a call left to answer as a console that went quiet while its
 * answer was on the wire. The number is written here rather than imported
 * because this module is part of the browser bundle, which carries no other
 * plugin's values (the seam's own constraint, recorded in the channel's module
 * doc and in `.agents/notes/implemented/architecture/2026-10-09-content-channel-seam-and-duplication.md`).
 */
export const MAX_CHANNEL_ID_CHARS = 256

/** The tool this channel serves. */
export const ACT_COMPONENT_TOOL_NAME = 'act_component'

/** Most steps one call may carry. A protocol ceiling; a deployment bounds nothing narrower. */
export const MAX_ACT_COMPONENT_STEPS = 8

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

/** One action a step names. */
export type ActComponentAction = (typeof ACT_COMPONENT_ACTIONS)[number]

/** Press the control one block declares under one key. */
export interface ActComponentClick {
  /** Discriminant. */
  readonly action: 'click'
  /** The block the control belongs to; the whole entry when absent. */
  readonly node?: string
  /** The action key the component declares for that control. */
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

/** Wait for one block or one declared control to be drawn. */
export interface ActComponentWait {
  /** Discriminant. */
  readonly action: 'wait'
  /** The block to wait for. */
  readonly node?: string
  /** The action key to wait for. */
  readonly key?: string
  /** How long to wait, in milliseconds; {@link DEFAULT_WAIT_MS} when absent. */
  readonly timeoutMs?: number
}

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
 * How one step ended, in the shared channel's own vocabulary.
 *
 * A step that ran or never ran carries no message, and the one that stopped the
 * call always does: the model reads that sentence to decide its next step, so an
 * arm without one would be an answer with nothing to act on.
 */
export type ActComponentStepResult = ActStepResult

/**
 * What a claimed call answers with when the entry was there.
 *
 * The shape is the shared channel's own — the same one a call that ran steps on
 * a page answers with — because both domains answer the same question: which
 * step ran, which one stopped the call, and what the entry's own controls said.
 * In this domain `page` is the component entry, which is the thing the call
 * acted on.
 */
export type ActComponentReport = ActOutcome

/** What a claimed call answers with when there was nothing to run the steps on. */
export type ActComponentFailure = Extract<ChannelOutcome, { status: 'error' }>

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

/** Whole current value of the projection this package publishes for its own calls. */
export interface ActComponentView {
  /** Every open call, oldest first. */
  readonly pending: readonly ActComponentCall[]
}

/**
 * Whether one settled call's outcome reports steps that ran.
 * @param outcome - what the call settled as.
 * @returns whether it reports steps rather than a refusal to run any.
 */
export function isActComponentReport(outcome: ActComponentOutcome): outcome is ActComponentReport {
  return outcome.status === 'done' || outcome.status === 'failed'
}

/** Whether one decoded value is a target name the components' own alphabet admits. */
function isTarget(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TARGET_CHARS && TOKEN_CHARSET.test(value)
}

/**
 * Read one step from a decoded value.
 * @param value - the step, however malformed.
 * @returns the step, or `undefined` when the value is not one this tool runs.
 */
export function readActComponentStep(value: unknown): ActComponentStep | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const step = value as {
    action?: unknown
    node?: unknown
    key?: unknown
    name?: unknown
    value?: unknown
    timeoutMs?: unknown
  }
  // A block named where the entry itself may be searched: absent means the whole
  // entry, and a name that is not one of the components' own ids is refused
  // rather than searched for.
  if (step.node !== undefined && !isTarget(step.node)) return undefined
  switch (step.action) {
    case 'click': return isTarget(step.key)
      ? { action: 'click', ...step.node === undefined ? {} : { node: step.node }, key: step.key }
      : undefined
    case 'set':
      return isTarget(step.name) && typeof step.value === 'string' && step.value.length <= MAX_SET_VALUE_CHARS
        ? { action: 'set', ...step.node === undefined ? {} : { node: step.node }, name: step.name, value: step.value }
        : undefined
    case 'wait': {
      if (step.key !== undefined && !isTarget(step.key)) return undefined
      if (step.node === undefined && step.key === undefined) return undefined
      if (step.timeoutMs !== undefined
        && (typeof step.timeoutMs !== 'number' || !Number.isInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > MAX_WAIT_MS)) {
        return undefined
      }
      return {
        action: 'wait',
        ...step.node === undefined ? {} : { node: step.node },
        ...step.key === undefined ? {} : { key: step.key },
        ...step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs as number },
      }
    }
    // The step union is closed and typed; the arm keeps a new action loud.
    /* v8 ignore next 2 -- the step union is closed and typed */
    default: return undefined
  }
}

/**
 * Read one call's arguments from a decoded value.
 *
 * A field this reading does not take makes the whole call unreadable rather
 * than partially understood: the tool's own schema refuses that call too, so a
 * browser told to run half of it would be running something nobody asked for.
 * @param value - the decoded arguments, however malformed.
 * @returns the arguments, or `undefined` when the value is not a runnable set.
 */
export function parseActComponentArgs(value: unknown): ActComponentArgs | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { entry?: unknown; steps?: unknown }
  if (typeof candidate.entry !== 'string' || candidate.entry.length === 0 || candidate.entry.length > MAX_ENTRY_ID_LENGTH) return undefined
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0 || candidate.steps.length > MAX_ACT_COMPONENT_STEPS) return undefined
  const steps: ActComponentStep[] = []
  for (const raw of candidate.steps) {
    const step = readActComponentStep(raw)
    if (step === undefined) return undefined
    steps.push(step)
  }
  return { entry: candidate.entry, steps }
}

/** Whether one decoded value is a non-empty name inside a bound. */
function isName(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/** Whether one decoded value is a text field inside a bound. */
function isText(value: unknown, max: number = MAX_TARGET_CHARS): value is string {
  return typeof value === 'string' && value.length <= max
}

/**
 * Read one posted `act_component` outcome.
 *
 * A wire boundary: the document crossed a process, so its own contract is
 * checked here rather than trusted from the type. Every string carries a bound
 * of its own, so a forged report cannot make the host carry an arbitrary
 * document to the model.
 *
 * The result is the shared channel's own vocabulary rather than a type of this
 * package's: the member that reads a report hands it to the waiting tool
 * through that channel, and a second spelling of the same document would be one
 * more place for the two to disagree.
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
    // The two refusals this domain posts, plus the one every reader shares for
    // a failure of its own: `empty` when the column holds no component entry,
    // `front-changed` when it holds another, `engine` when the steps threw.
    if (outcome.code !== 'empty' && outcome.code !== 'front-changed' && outcome.code !== 'engine') return undefined
    if (!isText(outcome.message, MAX_MESSAGE_CHARS)) return undefined
    return { status: 'error', code: outcome.code, message: outcome.message }
  }
  if (outcome.status !== 'done' && outcome.status !== 'failed') return undefined
  const page = outcome.page
  if (page === null || typeof page !== 'object') return undefined
  const named = page as { id?: unknown; title?: unknown }
  if (!isName(named.id, MAX_ENTRY_ID_LENGTH) || !isText(named.title, MAX_TITLE_CHARS)) return undefined
  if (!isText(outcome.title, MAX_TITLE_CHARS)) return undefined
  if (typeof outcome.truncated !== 'boolean') return undefined
  if (!Array.isArray(outcome.steps) || outcome.steps.length > MAX_ACT_COMPONENT_STEPS) return undefined
  if (!outcome.steps.every(isStepResult)) return undefined
  if (!isText(outcome.text, MAX_REPORT_TEXT_CHARS)) return undefined
  return {
    status: outcome.status,
    page: { id: named.id, title: named.title },
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
  // The same reading the page domain's reports get: the step that stopped the
  // call is the one carrier of a message, and a failure without one is the
  // answer the model can do nothing with.
  if (step.status === 'failed') return isText(step.message, MAX_MESSAGE_CHARS)
  if (step.status !== 'ok' && step.status !== 'skipped') return false
  return step.message === undefined
}

/**
 * Read one posted `act_component` report.
 *
 * A wire boundary: the document crossed a process, so its own contract is
 * checked here rather than trusted from the type. The call and the tab are read
 * as names, and the outcome carries its own bounds.
 * @param body - the decoded request body, however malformed.
 * @returns the report, or `undefined` when the body is not one.
 */
export function parseActComponentReport(body: unknown): ChannelReportRequest | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const candidate = body as { callId?: unknown; tabId?: unknown; outcome?: unknown }
  if (!isName(candidate.callId, MAX_CHANNEL_ID_CHARS) || !isName(candidate.tabId, MAX_CHANNEL_ID_CHARS)) return undefined
  const outcome = parseActComponentOutcome(candidate.outcome)
  return outcome === undefined ? undefined : { callId: candidate.callId, tabId: candidate.tabId, outcome }
}

/** Every tool whose calls the projection below publishes. */
const CHANNEL_TOOLS: ReadonlySet<string> = new Set([ACT_COMPONENT_TOOL_NAME])

/**
 * Read the call one committed event opened, in either of the two log shapes.
 * @param event - the committed session event.
 * @returns the call, or `undefined` when the event opens no usable one.
 */
export function readActComponentCall(event: SessionEvent): ActComponentCall | undefined {
  if (event.type === 'tool/call') {
    // The name is read before the arguments are: this fold runs over every
    // event of every session, and parsing the JSON of every tool call in the
    // log to throw it away is a cost the whole harness would pay for.
    if (!CHANNEL_TOOLS.has(event.data.name)) return undefined
    let decoded: unknown
    try {
      decoded = JSON.parse(event.data.arguments) as unknown
    } catch (_argumentsAreNotJson) {
      // A model can emit anything as arguments; the tool refuses the same call.
      return undefined
    }
    const args = parseActComponentArgs(decoded)
    return args === undefined ? undefined : { callId: event.data.callId, tool: ACT_COMPONENT_TOOL_NAME, args }
  }
  if (event.type === 'tool/ptc-dispatch-start') {
    if (!CHANNEL_TOOLS.has(event.data.name)) return undefined
    const args = parseActComponentArgs(event.data.arguments)
    return args === undefined ? undefined : { callId: event.data.subCallId, tool: ACT_COMPONENT_TOOL_NAME, args }
  }
  return undefined
}

/**
 * The call id one committed event closes.
 *
 * The result events carry no tool name, so the id is matched against the open
 * list instead: an id that is not in it removes nothing.
 * @param event - the committed session event.
 * @returns the settled call id, or `undefined` when the event settles none.
 */
export function settledActComponentCall(event: SessionEvent): string | undefined {
  if (event.type === 'tool/result') return event.data.message.source.callId
  if (event.type === 'tool/ptc-dispatch') return event.data.subCallId
  return undefined
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    componentAccess: ActComponentCall[]
  }
  interface SessionProjectionMap {
    /**
     * The `act_component` calls this session has open: every call of that tool
     * the log recorded without a result yet, in log order. It is how the host
     * asks the tab showing this session to act inside a component entry — no
     * host reaches a browser directly, so the request rides the session's own
     * projection stream and the seat showing that session picks it up.
     */
    componentAccess: ActComponentView
  }
}
