/**
 * The `contentAccess` projection unit: the `content_read` calls one session has
 * open right now.
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
import type { ContentAccessView, ContentReadRequest } from '../types.ts'
import { CONTENT_READ_TOOL_NAME, type ReadArgs } from './wire.ts'

/** The `contentAccess` unit as the registry's client-visible overload takes it: `wire` is required, not optional. */
type ContentAccessProjectionDefinition =
  & Omit<ProjectionDefinition<'contentAccess', ContentReadRequest[]>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'contentAccess', ContentReadRequest[]>['wire']> }

/** One call's arguments; the transform drops the absent ones rather than carrying explicit `undefined`. */
const argsSchema: ZodType<ReadArgs> = zod.object({
  mode: zod.enum(['outline', 'map']).optional(),
  scope: zod.string().optional(),
  after: zod.string().optional(),
  find: zod.string().optional(),
}).strict().transform(({ mode, scope, after, find }) => ({
  ...mode === undefined ? {} : { mode },
  ...scope === undefined ? {} : { scope },
  ...after === undefined ? {} : { after },
  ...find === undefined ? {} : { find },
}))

/** One open call, as both the persisted checkpoint and the wire payload carry it. */
const requestSchema: ZodType<ContentReadRequest> = zod.object({
  callId: zod.string(),
  tool: zod.literal(CONTENT_READ_TOOL_NAME),
  args: argsSchema,
}).strict()

/** Fold state: the open calls in log order. */
const stateSchema: ZodType<ContentReadRequest[]> = zod.array(requestSchema)

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
 * Read one call's arguments from the raw JSON string a `tool/call` records.
 * @param raw - the arguments exactly as the model produced them.
 * @returns the arguments, or `undefined` when the string is not a readable set.
 */
function parseArgs(raw: string): ReadArgs | undefined {
  try {
    return readArgs(JSON.parse(raw))
  } catch (_argumentsAreNotJson) {
    // A model can emit anything as arguments; the tool refuses the same call.
    return undefined
  }
}

/**
 * Read the read one committed event opened, in either of the two log shapes.
 * @param event - the committed session event.
 * @returns the request, or `undefined` when the event opens no readable call.
 */
export function readContentReadCall(event: SessionEvent): ContentReadRequest | undefined {
  if (event.type === 'tool/call') {
    if (event.data.name !== CONTENT_READ_TOOL_NAME) return undefined
    const args = parseArgs(event.data.arguments)
    return args === undefined ? undefined : { callId: event.data.callId, tool: CONTENT_READ_TOOL_NAME, args }
  }
  if (event.type === 'tool/code-dispatch-start') {
    if (event.data.name !== CONTENT_READ_TOOL_NAME) return undefined
    const args = readArgs(event.data.arguments)
    return args === undefined ? undefined : { callId: event.data.subCallId, tool: CONTENT_READ_TOOL_NAME, args }
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
 * Build the `contentAccess` projection unit.
 * @returns the definition to hand to `ctx.sessionProjections.register`.
 */
export function contentAccessProjection(): ContentAccessProjectionDefinition {
  return {
    key: 'contentAccess',
    stateSchema,
    init: () => [],
    apply: (state: ContentReadRequest[], event: SessionEvent) => {
      const opened = readContentReadCall(event)
      if (opened !== undefined) return [...state, opened]
      const settled = settledCallId(event)
      if (settled === undefined) return state
      const at = state.findIndex(request => request.callId === settled)
      return at === -1 ? state : [...state.slice(0, at), ...state.slice(at + 1)]
    },
    wire: { viewSchema, view: pending => ({ pending }) },
    stateVersion: 1,
  }
}
