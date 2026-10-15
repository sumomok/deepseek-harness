/**
 * The `componentAccess` projection unit: the calls of this package's two tools
 * one session has open right now.
 *
 * It is this package's request half of the shared content channel. A host
 * cannot address a browser, so a waiting call announces itself here, the seat
 * showing that session sees it in the projection stream every browser already
 * receives, and the answer comes back over the channel's claim and report
 * routes. A call leaves the list the moment its result reaches the log, so a
 * seat closed while the call timed out never starts acting on it or reading it.
 *
 * Both tools publish into one list because they reach one seat through one
 * domain: the arm's `tool` is what tells the seat which of the two it was
 * offered, and each tool's reading of its own arguments is the only reading
 * either arm takes. The list is published under this package's own key rather
 * than the page domain's: the arms of such a list are a domain's vocabulary —
 * its tool names and their arguments — and the two domains share the channel
 * rather than their calls. The fold is this unit's own: the channel module's
 * is a value of another plugin, which neither bundle of this package carries.
 *
 * The view also carries how long a claimed set of steps may run, because the
 * seat receives no configuration of this row's: the host's report deadline is
 * a deployment's choice, and the seat must stop acting before the host stops
 * waiting.
 * @module @deepseek-ai/dsh-experimental-component-surface/act-component-projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  ACT_COMPONENT_TOOL_NAME, parseActComponentArgs, readActComponentCall, settledComponentCall,
  type ActComponentArgs, type ComponentCall, type ComponentView,
} from './act-component-call.ts'
import {
  READ_COMPONENT_TOOL_NAME, parseReadComponentArgs, readReadComponentCall, type ReadComponentArgs,
} from './read-component-call.ts'

/** The issue a value carries when the shared parser could not read it. */
const UNREADABLE_ARGS = 'not a set of arguments this tool takes'

/**
 * The share of a claimed call's report deadline its steps may spend.
 *
 * The host's deadline starts when it grants the claim, and the seat's run
 * starts once the grant has come back to it; steps that spent the whole
 * deadline would be answered as a console that went quiet while the console
 * was still acting. The share is a fraction of that deadline rather than a
 * time of its own, so the deployment tunes `actTimeoutMs` and the steps follow
 * it. It is written here rather than imported from `content-frame` because
 * that package is a peer dependency and the host bundle inlines anything that
 * is not a production dependency, which would ship a second copy of the
 * channel's wire layer inside this package's artifact.
 */
const ACT_RUN_SHARE = 0.75

/**
 * The schema form of one tool's shared parser: the value becomes the
 * arguments, and a value the parser cannot read is refused.
 *
 * The alternative is a second declaration of the same arguments in zod beside
 * the reading the tool and the browser run, which drifts the first time a field
 * is added — silently, and only for calls already accepted everywhere else.
 * @param parse - that tool's own reading of its arguments.
 * @returns the schema node.
 */
function argsSchema<Args>(parse: (value: unknown) => Args | undefined): ZodType<Args> {
  return zod.unknown().transform((value, ctx) => {
    const parsed = parse(value)
    if (parsed !== undefined) return parsed
    ctx.addIssue({ code: 'custom', message: UNREADABLE_ARGS })
    return zod.NEVER
  })
}

/** The two tools' argument schemas, each the schema form of that tool's own parser. */
const actArgsSchema: ZodType<ActComponentArgs> = argsSchema(parseActComponentArgs)
const readArgsSchema: ZodType<ReadComponentArgs> = argsSchema(parseReadComponentArgs)

/** One open call of either of this package's tools, as both the checkpoint and the wire carry it. */
const callSchema: ZodType<ComponentCall> = zod.union([
  zod.object({
    callId: zod.string(),
    tool: zod.literal(ACT_COMPONENT_TOOL_NAME),
    args: actArgsSchema,
  }).strict(),
  zod.object({
    callId: zod.string(),
    tool: zod.literal(READ_COMPONENT_TOOL_NAME),
    args: readArgsSchema,
  }).strict(),
])

/** Fold state: the open calls in log order. */
const stateSchema: ZodType<ComponentCall[]> = zod.array(callSchema)

/** Wire payload schema of the `componentAccess` projection. */
const viewSchema: ZodType<ComponentView> = zod.object({
  pending: zod.array(callSchema),
  stepBudgetMs: zod.number().int().nonnegative(),
}).strict()

/** The unit as the registry's client-visible overload takes it: `wire` is required, not optional. */
type ActComponentProjectionDefinition =
  & Omit<ProjectionDefinition<'componentAccess', ComponentCall[]>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'componentAccess', ComponentCall[]>['wire']> }

/**
 * Fold this unit's open-call list over one committed event: the call an event
 * opened is appended, and the one it settled is dropped.
 * @param state - the open calls, oldest first.
 * @param event - the committed session event.
 * @returns the next state, the same array when nothing moved.
 */
function foldPending(state: ComponentCall[], event: SessionEvent): ComponentCall[] {
  // One event opens at most one call, and a call of either tool is settled by
  // the same result event: the tool name is read first, and the settle test
  // carries none.
  const opened = readActComponentCall(event) ?? readReadComponentCall(event)
  if (opened !== undefined) return [...state, opened]
  const settled = settledComponentCall(event)
  if (settled === undefined) return state
  const at = state.findIndex(call => call.callId === settled)
  return at === -1 ? state : [...state.slice(0, at), ...state.slice(at + 1)]
}

/**
 * Build the `componentAccess` unit.
 *
 * The fold reads the log alone and depends on no catalog: which components this
 * deployment offers decides what a call may draw and what an action means, while
 * the projection carries the call to the browser that will act on it or read it.
 * @param answerTimeoutMs - how long the host waits for a claimed call's
 * report, of which the view publishes the share a set of steps may run for.
 * @returns the definition to hand to `ctx.sessionProjections.register`.
 */
export function actComponentProjection(answerTimeoutMs: number): ActComponentProjectionDefinition {
  const stepBudgetMs = Math.floor(answerTimeoutMs * ACT_RUN_SHARE)
  return {
    key: 'componentAccess',
    stateSchema,
    init: () => [],
    apply: foldPending,
    // The registry parses every view against `viewSchema` before it leaves,
    // and the fold holds only calls the same readings produced.
    wire: { viewSchema, view: pending => ({ pending: [...pending], stepBudgetMs }) },
    stateVersion: 1,
  }
}
