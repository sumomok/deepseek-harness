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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CallTable, CallTimeouts } from '@deepseek-ai/dsh-experimental-content-frame/access/pending'
import { isEntryId, isTarget } from './act-component-call.ts'
import { READ_COMPONENT_TOOL_NAME, parseReadComponentArgs } from './read-component-call.ts'
import {
  BAD_ENTRY_REFUSAL, BAD_NODE_REFUSAL, CANCELLED_REFUSAL, ENTRY_DESCRIPTION, MISREPORTED_REFUSAL,
  NODE_DESCRIPTION, NO_AGENT_REFUSAL, READ_COMPONENT_DESCRIPTION, failureRefusal, unclaimedRefusal,
  unverifiedRefusal,
} from './read-component-text.ts'
import { channelCallCard, channelResultCard, settleChannelCall, type ChannelToolText } from './channel-tool.ts'

/** Title of the call card, in the pending and the settled state alike. */
const CALL_TITLE = 'Read the component entry in the content panel'

/** The sentences this tool's settlement rejects with. */
const SETTLE_TEXT: ChannelToolText = {
  noAgent: NO_AGENT_REFUSAL,
  misreported: MISREPORTED_REFUSAL,
  cancelled: CANCELLED_REFUSAL,
  unclaimed: unclaimedRefusal,
  failure: failureRefusal,
}

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
 * Refuse arguments no console can read, naming the parameter to fix.
 * @param args - the arguments as the schema validated them.
 * @throws {Error} naming the parameter to fix.
 */
function checkReadArgs(args: { readonly entry: string; readonly node?: string }): void {
  if (!isEntryId(args.entry)) throw new Error(BAD_ENTRY_REFUSAL)
  if (args.node !== undefined && !isTarget(args.node)) throw new Error(BAD_NODE_REFUSAL)
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
      checkReadArgs(args)
      // A claimed call that never reported is a value: the reading may have
      // been composed and lost on its way back, and only the console could say.
      return await settleChannelCall<ReadComponentValue>(
        calls,
        timeouts,
        exec,
        SETTLE_TEXT,
        outcome => (outcome.status === 'read' ? { status: 'done', entry: outcome.page, text: outcome.text } : undefined),
        { status: 'unverified', text: unverifiedRefusal(timeouts.answerTimeoutMs) },
      )
    },
    presentCall: (args) => {
      const parsed = parseReadComponentArgs(args)
      return channelCallCard(
        CALL_TITLE,
        args,
        parsed === undefined ? undefined : `${parsed.entry}${parsed.node === undefined ? '' : `: ${parsed.node}`}`,
      )
    },
    presentResult: (_args, result) => channelResultCard(CALL_TITLE, result),
  })
}
