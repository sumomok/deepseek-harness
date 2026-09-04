/**
 * The `contentAccess` projection unit: the page-channel calls one session has
 * open right now — the four reads waiting for a listing, a tree, an element's
 * attributes or its text, the read waiting for one element's pixels, and the
 * `content_act` calls waiting for their steps to run.
 *
 * It is the request half of the read channel. A host cannot address a browser,
 * so a waiting call announces itself here, the seat showing that session sees
 * it in the projection stream every browser already receives, and the answer
 * comes back over the claim/report routes. A call leaves the list the moment
 * its result reaches the log, so a seat that was closed while the call timed
 * out never starts reading for it.
 *
 * Two log shapes carry a call and both count: a top-level `tool/call`, whose
 * `arguments` is raw JSON, and a Code Mode `tool/code-dispatch-start`, whose
 * arguments are already decoded and whose call id is the `subCallId`. A model
 * reaching the tool through `run_code` logs only the second, so a fold reading
 * one shape would leave those reads unclaimable.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/requests-projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Type-only: pulls this package's own `contentAccess` projection declarations.
import type { ContentAccessRequest, ContentAccessView } from '../types.ts'
import {
  CONTENT_ACT_TOOL_NAME, CONTENT_READ_ATTRS_TOOL_NAME, CONTENT_READ_DOM_CONTENT_TOOL_NAME,
  CONTENT_READ_DOM_TOOL_NAME, CONTENT_READ_IMAGE_TOOL_NAME, CONTENT_READ_TOOL_NAME, parseActArgs, parseDomArgs,
  parseElementArgs, type ActArgs, type DomArgs, type ElementArgs, type ReadArgs,
} from './wire.ts'
import { UNPUBLISHABLE_CALL_REFUSAL } from './text.ts'

/** The `contentAccess` unit as the registry's client-visible overload takes it: `wire` is required, not optional. */
type ContentAccessProjectionDefinition =
  & Omit<ProjectionDefinition<'contentAccess', ContentAccessRequest[]>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'contentAccess', ContentAccessRequest[]>['wire']> }

/** The issue a value carries when the parser this schema is could not read it. */
const UNREADABLE_ARGS = 'not a set of arguments this tool takes'

/**
 * The schema form of one parser: the value becomes whatever that parser makes
 * of it, and a value the parser cannot read is refused.
 *
 * The alternative is a second declaration of the same arguments beside the
 * tool's own reading of them, which drifts the first time a field is added —
 * silently, and only for calls that have already been accepted everywhere else.
 * That is how a step's `mark` reached one console as `unrecognized_keys` about
 * a field the tool documents: the tool took the call, the fold took it, and the
 * projection then refused the value it had just built.
 * @param read - the parser the tool and the fold already read these arguments with.
 * @returns the schema, whose output is the parser's own value.
 */
function parsedBy<T>(read: (value: unknown) => T | undefined): ZodType<T> {
  return zod.unknown().transform((value, ctx) => {
    const parsed = read(value)
    if (parsed !== undefined) return parsed
    ctx.addIssue({ code: 'custom', message: UNREADABLE_ARGS })
    return zod.NEVER
  })
}

/** One read call's arguments, read by {@link readArgs}. */
const argsSchema: ZodType<ReadArgs> = parsedBy(readArgs)

/** One act call's arguments, read by the wire's own {@link parseActArgs}. */
const actArgsSchema: ZodType<ActArgs> = parsedBy(parseActArgs)

/** One element-tree call's arguments, read by the wire's own {@link parseDomArgs}. */
const domArgsSchema: ZodType<DomArgs> = parsedBy(parseDomArgs)

/** One single-element call's arguments, read by the wire's own {@link parseElementArgs}. */
const elementArgsSchema: ZodType<ElementArgs> = parsedBy(parseElementArgs)

/** One open call of any tool, as both the persisted checkpoint and the wire payload carry it. */
const requestSchema: ZodType<ContentAccessRequest> = zod.union([
  zod.object({
    callId: zod.string(),
    tool: zod.literal(CONTENT_READ_TOOL_NAME),
    args: argsSchema,
  }).strict(),
  zod.object({
    callId: zod.string(),
    tool: zod.literal(CONTENT_ACT_TOOL_NAME),
    args: actArgsSchema,
  }).strict(),
  zod.object({
    callId: zod.string(),
    tool: zod.literal(CONTENT_READ_DOM_TOOL_NAME),
    args: domArgsSchema,
  }).strict(),
  zod.object({
    callId: zod.string(),
    tool: zod.literal(CONTENT_READ_ATTRS_TOOL_NAME),
    args: elementArgsSchema,
  }).strict(),
  zod.object({
    callId: zod.string(),
    tool: zod.literal(CONTENT_READ_DOM_CONTENT_TOOL_NAME),
    args: elementArgsSchema,
  }).strict(),
  zod.object({
    callId: zod.string(),
    tool: zod.literal(CONTENT_READ_IMAGE_TOOL_NAME),
    args: elementArgsSchema,
  }).strict(),
])

/** Fold state: the open calls in log order. */
const stateSchema: ZodType<ContentAccessRequest[]> = zod.array(requestSchema)

/** Wire payload schema of the `contentAccess` projection. */
const viewSchema: ZodType<ContentAccessView> = zod.object({ pending: zod.array(requestSchema) }).strict()

/**
 * Read one call's arguments from a decoded value.
 *
 * A field of the wrong type makes the whole call unreadable rather than
 * partially understood: the tool's own schema would refuse that call too, so
 * publishing it as pending would ask a browser to read a page for a call whose
 * body never opened a wait.
 * @param value - the decoded arguments, however malformed.
 * @returns the arguments, or `undefined` when the value is not a readable set.
 */
function readArgs(value: unknown): ReadArgs | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<Record<keyof ReadArgs, unknown>>
  if (candidate.mode !== undefined && candidate.mode !== 'outline' && candidate.mode !== 'map') return undefined
  for (const text of [candidate.scope, candidate.after, candidate.find]) {
    if (text !== undefined && typeof text !== 'string') return undefined
  }
  return {
    ...candidate.mode === undefined ? {} : { mode: candidate.mode },
    ...typeof candidate.scope === 'string' ? { scope: candidate.scope } : {},
    ...typeof candidate.after === 'string' ? { after: candidate.after } : {},
    ...typeof candidate.find === 'string' ? { find: candidate.find } : {},
  }
}

/**
 * Decode the raw JSON string a `tool/call` records its arguments as.
 * @param raw - the arguments exactly as the model produced them.
 * @returns the decoded value, or `undefined` when the string is not JSON.
 */
function decodeArgs(raw: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(raw) as unknown }
  } catch (_argumentsAreNotJson) {
    // A model can emit anything as arguments; the tool refuses the same call.
    return undefined
  }
}

/** Every tool whose calls this fold publishes, for the check that runs before the arguments are decoded. */
const CHANNEL_TOOLS: ReadonlySet<string> = new Set([
  CONTENT_READ_TOOL_NAME, CONTENT_ACT_TOOL_NAME, CONTENT_READ_DOM_TOOL_NAME, CONTENT_READ_ATTRS_TOOL_NAME,
  CONTENT_READ_DOM_CONTENT_TOOL_NAME, CONTENT_READ_IMAGE_TOOL_NAME,
])

/**
 * Read the call one event's arguments open, for whichever of this channel's
 * tools the event names.
 *
 * One switch rather than one reader per tool: the two log shapes reach it with
 * the same three values, and a tool added to the channel and not to this switch
 * would publish nothing for a browser to claim.
 * @param name - the tool the event names.
 * @param value - the decoded arguments, however malformed.
 * @param callId - the id to claim and report against.
 * @returns the request, or `undefined` when the event names another tool or its
 * arguments are not a usable set.
 */
function requestFor(name: string, value: unknown, callId: string): ContentAccessRequest | undefined {
  switch (name) {
    case CONTENT_READ_TOOL_NAME: {
      const args = readArgs(value)
      return args === undefined ? undefined : { callId, tool: CONTENT_READ_TOOL_NAME, args }
    }
    case CONTENT_ACT_TOOL_NAME: {
      const args = parseActArgs(value)
      return args === undefined ? undefined : { callId, tool: CONTENT_ACT_TOOL_NAME, args }
    }
    case CONTENT_READ_DOM_TOOL_NAME: {
      const args = parseDomArgs(value)
      return args === undefined ? undefined : { callId, tool: CONTENT_READ_DOM_TOOL_NAME, args }
    }
    case CONTENT_READ_ATTRS_TOOL_NAME: {
      const args = parseElementArgs(value)
      return args === undefined ? undefined : { callId, tool: CONTENT_READ_ATTRS_TOOL_NAME, args }
    }
    case CONTENT_READ_DOM_CONTENT_TOOL_NAME: {
      const args = parseElementArgs(value)
      return args === undefined ? undefined : { callId, tool: CONTENT_READ_DOM_CONTENT_TOOL_NAME, args }
    }
    case CONTENT_READ_IMAGE_TOOL_NAME: {
      const args = parseElementArgs(value)
      return args === undefined ? undefined : { callId, tool: CONTENT_READ_IMAGE_TOOL_NAME, args }
    }
    // The log carries every tool's calls; this fold publishes this channel's.
    default: return undefined
  }
}

/**
 * Read the call one committed event opened, in either of the two log shapes and
 * for any of the channel's tools.
 * @param event - the committed session event.
 * @returns the request, or `undefined` when the event opens no usable call.
 */
export function readContentAccessCall(event: SessionEvent): ContentAccessRequest | undefined {
  if (event.type === 'tool/call') {
    // The name is read before the arguments are: this fold runs over every
    // event of every session, and parsing the JSON of every tool call in the
    // log to throw it away is a cost the whole harness would pay for.
    if (!CHANNEL_TOOLS.has(event.data.name)) return undefined
    const decoded = decodeArgs(event.data.arguments)
    return decoded === undefined ? undefined : requestFor(event.data.name, decoded.value, event.data.callId)
  }
  if (event.type === 'tool/code-dispatch-start') {
    return requestFor(event.data.name, event.data.arguments, event.data.subCallId)
  }
  return undefined
}

/**
 * The call id one committed event closes, whichever tool it belonged to.
 *
 * The result events carry no tool name, so the id is matched against the open
 * list instead: an id that is not in it removes nothing.
 * @param event - the committed session event.
 * @returns the settled call id, or `undefined` when the event settles none.
 */
function settledCallId(event: SessionEvent): string | undefined {
  if (event.type === 'tool/result') return event.data.message.source.callId
  if (event.type === 'tool/code-dispatch') return event.data.subCallId
  return undefined
}

/**
 * What this unit needs of a logger: one line for a call it folded and then
 * refused, which is the whole of what the model's own sentence leaves out.
 */
export interface ProjectionLogger {
  /**
   * Record one line.
   * @param message - the line.
   */
  readonly warn: (message: string) => void
}

/**
 * The view this unit publishes, checked against the schema that guards it.
 *
 * The registry parses every view before it leaves, and a failure there reaches
 * the model as the validator's raw issue list — an argument to change, about a
 * call whose arguments are fine. Checking here turns the same defect into one
 * sentence the model can act on and one log line carrying the issues.
 * @param pending - the calls this fold holds open.
 * @param logger - where the refused value's issues are recorded.
 * @returns the wire value.
 */
function publishable(pending: ContentAccessRequest[], logger: ProjectionLogger): ContentAccessView {
  const value = { pending }
  const read = viewSchema.safeParse(value)
  if (read.success) return value
  logger.warn(`contentAccess refused its own view: ${JSON.stringify(read.error.issues)}`)
  throw new Error(UNPUBLISHABLE_CALL_REFUSAL)
}

/**
 * Build the `contentAccess` projection unit.
 * @param logger - where a value this unit folded and then refused is recorded.
 * @returns the definition to hand to `ctx.sessionProjections.register`.
 */
export function contentAccessProjection(logger: ProjectionLogger): ContentAccessProjectionDefinition {
  return {
    key: 'contentAccess',
    stateSchema,
    init: () => [],
    apply: (state: ContentAccessRequest[], event: SessionEvent) => {
      const opened = readContentAccessCall(event)
      if (opened !== undefined) return [...state, opened]
      const settled = settledCallId(event)
      if (settled === undefined) return state
      const at = state.findIndex(request => request.callId === settled)
      return at === -1 ? state : [...state.slice(0, at), ...state.slice(at + 1)]
    },
    wire: { viewSchema, view: pending => publishable(pending, logger) },
    stateVersion: 4,
  }
}
