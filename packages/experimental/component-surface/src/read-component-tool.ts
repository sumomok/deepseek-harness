/**
 * `read_component` — the agent reads the component entry the user is looking
 * at, in the vocabulary it acts by.
 *
 * The body runs nothing itself. It validates the arguments, opens a call on the
 * shared content channel, and answers with the reading the tab showing this
 * session reports: which blocks are drawn, what the entry's controls are and
 * under which keys, what its fields presently hold, and which dialog is open.
 * Everything it answers with was read off the console's own document through
 * the same resolution a step runs through, so a key the reading names is a key
 * a follow-up call can press.
 *
 * Nothing here writes: a read is a read, and the entry is the model's own
 * drawing rather than the user's data — the values it reports are the ones the
 * console draws, and a secret field's value is reported as hidden rather than
 * printed. Only the endings where nothing was read at all — no console, no
 * entry, refused arguments — reject.
 * @module @deepseek-ai/dsh-experimental-component-surface/read-component-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CallTable, CallTimeouts } from '@deepseek-ai/dsh-experimental-content-frame/src/access/pending.ts'
import type { ChannelOutcome } from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'
import { isTarget } from './act-component-call.ts'
import { MAX_ENTRY_ID_LENGTH } from './component-call.ts'
import {
  READ_COMPONENT_TOOL_NAME, parseReadComponentArgs,
  type ReadComponentArgs,
} from './read-component-call.ts'
import {
  BAD_ENTRY_REFUSAL, BAD_NODE_REFUSAL, CANCELLED_REFUSAL, ENTRY_DESCRIPTION, MISREPORTED_REFUSAL,
  NODE_DESCRIPTION, NO_AGENT_REFUSAL, READ_COMPONENT_DESCRIPTION, failureRefusal, unclaimedRefusal,
  unverifiedRefusal,
} from './read-component-text.ts'

/** Title of the call card, in the pending and the settled state alike. */
const CALL_TITLE = 'Read the component entry in the content panel'

/**
 * How much of the raw arguments the call card prints for a call this tool could
 * not read.
 */
const MAX_RAW_INPUT_CHARS = 200

/** The canonical outcome declared by the `read_component` output schema. */
export interface ReadComponentValue {
  /** Whether the entry was read, or the console that claimed the call never said. */
  status: 'done' | 'unverified'
  /** The entry that was read; absent when no console reported. */
  entry?: { id: string; title: string }
  /** The reading itself, as the console composed and bounded it. */
  text: string
}

/**
 * Take the model's arguments as a reading a console can run, or say what is
 * wrong with them.
 * @param args - the arguments as the schema validated them.
 * @returns the validated arguments.
 * @throws {Error} naming the parameter to fix.
 */
function readArgs(args: unknown): ReadComponentArgs {
  const candidate = args as { entry?: unknown; node?: unknown }
  if (typeof candidate?.entry !== 'string' || candidate.entry.length === 0 || candidate.entry.length > MAX_ENTRY_ID_LENGTH) {
    throw new Error(BAD_ENTRY_REFUSAL)
  }
  if (candidate.node !== undefined && !isTarget(candidate.node)) throw new Error(BAD_NODE_REFUSAL)
  return { entry: candidate.entry, ...candidate.node === undefined ? {} : { node: candidate.node } }
}

/**
 * Whether one settled call's outcome reports a reading.
 *
 * The channel module offers the same test and this file does not take it: a
 * value imported from another plugin would put a second copy of the channel's
 * wire layer inside this package's host bundle, for the reason
 * `act-component-tool.ts` states. The test is a discriminant check, and the
 * channel keeps the one the deployment actually runs.
 * @param outcome - what the call settled as.
 * @returns whether it reports a reading rather than anything another tool answers with.
 */
function reportsReading(outcome: ChannelOutcome): outcome is Extract<ChannelOutcome, { status: 'read' }> {
  return outcome.status === 'read'
}

/**
 * Build the `read_component` tool for one deployment.
 * @param calls - the channel table this domain's calls wait in.
 * @param timeouts - the deployment's deadlines, also quoted in the timeout answers.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function readComponentTool(calls: CallTable, timeouts: CallTimeouts): ToolDefinition {
  return defineTool({
    name: READ_COMPONENT_TOOL_NAME,
    description: READ_COMPONENT_DESCRIPTION,
    parameters: {
      entry: { type: 'string', required: true, description: ENTRY_DESCRIPTION },
      node: { type: 'string', description: NODE_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            enum: ['done', 'unverified'],
            required: true,
            description: 'Whether the entry was read, or the console that claimed the call never reported.',
          },
          entry: {
            type: 'object',
            additionalProperties: false,
            description: 'The component entry that was read.',
            properties: {
              id: { type: 'string', required: true, description: 'The entry id the call named.' },
              title: { type: 'string', required: true, description: 'The title the column shows for it.' },
            },
          },
          text: {
            type: 'string',
            required: true,
            description: 'The reading: the blocks drawn, the controls and their keys, and the fields with their values.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({ entry: value.entry?.title ?? '' }),
    },
    // The read writes nothing and only waits on a browser, so two reads in one
    // step are answered by the same seat one after the other rather than
    // queueing two claim deadlines.
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ReadComponentValue> {
      // Read before the wait opens: a call whose arguments this tool cannot
      // read is one no console should be asked to answer.
      readArgs(args)
      // The entry belongs to a session's column, and the pending list a browser
      // reads is that session's projection; a caller with no session has no
      // column to read.
      if (!exec.agent) throw new Error(NO_AGENT_REFUSAL)
      const settlement = await calls.open(exec.callId, exec.agent.session.header.id, exec.signal, timeouts)
      switch (settlement.kind) {
        case 'reported': {
          // A failure arm is how the console says there was no entry to read;
          // anything a step report or a page read answers with is no answer to
          // this call.
          const outcome = settlement.outcome
          if (reportsReading(outcome)) return { status: 'done', entry: outcome.page, text: outcome.text }
          if (outcome.status !== 'error') throw new Error(MISREPORTED_REFUSAL)
          throw new Error(failureRefusal(outcome.message))
        }
        case 'unclaimed': throw new Error(unclaimedRefusal(timeouts.claimTimeoutMs))
        // The console took the call, so the reading may have been composed and
        // lost on its way back; only the console could say which.
        case 'unanswered': return {
          status: 'unverified',
          text: unverifiedRefusal(timeouts.answerTimeoutMs),
        }
        // Whatever this returns is replaced by the registry's aborted result;
        // the message exists for a caller reading the rejection directly.
        case 'aborted': throw new Error(CANCELLED_REFUSAL)
        /* v8 ignore next 2 -- the settlement union is closed and typed; the arm keeps a new member loud. */
        default: throw new Error(`component-surface: unknown settlement ${JSON.stringify(settlement)}`)
      }
    },
    // Display only, and it runs on replay of whatever was logged, so it reads
    // the arguments with the parser that answers `undefined` rather than with
    // the body's own, which throws.
    presentCall: (args): GenericCallView => {
      const parsed = parseReadComponentArgs(args)
      const raw = JSON.stringify(args)
      return {
        card: 'generic',
        title: CALL_TITLE,
        kind: 'other',
        rawInput: parsed === undefined
          ? (raw.length > MAX_RAW_INPUT_CHARS ? `${raw.slice(0, MAX_RAW_INPUT_CHARS)}…` : raw)
          : `${parsed.entry}${parsed.node === undefined ? '' : `: ${parsed.node}`}`,
      }
    },
    presentResult: (_args, result): GenericResultView => ({
      card: 'generic',
      title: result.content.find(block => block.type === 'text')?.text.split('\n')[0] ?? CALL_TITLE,
    }),
  })
}
