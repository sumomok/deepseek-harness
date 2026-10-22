/**
 * `act_component` — the agent acts inside the component entry the user is
 * looking at.
 *
 * The body runs nothing itself. It validates the steps, opens a call on the
 * shared content channel, and answers with what the tab showing this session
 * reports: which steps ran, which one stopped the call, and what the entry's
 * own controls said. Every step therefore happens in the console's own
 * document, under the block's own React or Vue handlers, and nothing about the
 * result is composed from what the host expected to happen.
 *
 * A step that fails is a value, not a rejection: the call stops there, the rest
 * are reported as skipped, and the model reads which step stopped it and why in
 * the same answer. Only the endings where nothing ran at all — no console, no
 * entry, refused arguments — reject.
 * @module @deepseek-ai/dsh-experimental-component-surface/act-component-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CallTable, CallTimeouts } from '@deepseek-ai/dsh-experimental-content-frame/access/pending'
import type { ActOutcome } from '@deepseek-ai/dsh-experimental-content-frame/access/wire'
import {
  ACT_COMPONENT_ACTIONS, ACT_COMPONENT_TOOL_NAME, MAX_ACT_COMPONENT_STEPS, ignoredStepField, isActComponentReport,
  isEntryId, parseActComponentArgs, readActComponentStep,
} from './act-component-call.ts'
import {
  ACTION_DESCRIPTION, ACT_COMPONENT_DESCRIPTION, BAD_ENTRY_REFUSAL, CANCELLED_REFUSAL, ENTRY_DESCRIPTION,
  KEY_DESCRIPTION, MISREPORTED_REFUSAL, NAME_DESCRIPTION, NODE_DESCRIPTION, NO_AGENT_REFUSAL, NO_STEPS_REFUSAL,
  ROW_DESCRIPTION, STEP_REFUSAL_TEXT, STEPS_DESCRIPTION, TIMEOUT_DESCRIPTION, VALUE_DESCRIPTION, failureRefusal, ignoredFieldReason,
  stepRefusal, tooManyStepsRefusal, unclaimedRefusal, unverifiedRefusal,
} from './act-component-text.ts'
import { channelCallCard, channelResultCard, settleChannelCall, type ChannelToolText } from './channel-tool.ts'

/** Title of the call card, in the pending and the settled state alike. */
const CALL_TITLE = 'Act inside the component in the content panel'

/** The sentences this tool's settlement rejects with. */
const SETTLE_TEXT: ChannelToolText = {
  noAgent: NO_AGENT_REFUSAL,
  misreported: MISREPORTED_REFUSAL,
  cancelled: CANCELLED_REFUSAL,
  unclaimed: unclaimedRefusal,
  failure: failureRefusal,
}

/** The canonical outcome declared by the `act_component` output schema. */
export interface ActComponentValue {
  /** Whether every step ran, one of them stopped the call, or the console never said. */
  status: 'done' | 'failed' | 'unverified'
  /** The entry the steps ran on; absent when no console reported. */
  entry?: { id: string; title: string }
  /** One entry per requested step, in order; empty when no console reported. */
  steps: { index: number; status: 'ok' | 'failed' | 'skipped'; message?: string }[]
  /** What ran, and what the entry's own controls answered. */
  text: string
}

/**
 * Refuse arguments no console can run, saying what is wrong with them.
 *
 * The schema has already checked the field types; this checks what it cannot
 * state — the entry id's bound, a field naming a target or a value the step's
 * action does not take, and each step's target and row alphabet — with the readers a
 * browser runs, and names the step to fix.
 * @param args - the arguments as the schema validated them.
 * @throws {Error} naming the step and the parameter to fix.
 */
function checkActArgs(args: { readonly entry: string; readonly steps: readonly unknown[] }): void {
  if (!isEntryId(args.entry)) throw new Error(BAD_ENTRY_REFUSAL)
  if (args.steps.length === 0) throw new Error(NO_STEPS_REFUSAL)
  if (args.steps.length > MAX_ACT_COMPONENT_STEPS) throw new Error(tooManyStepsRefusal(MAX_ACT_COMPONENT_STEPS))
  for (const [at, raw] of args.steps.entries()) {
    // Asked first: the step reader refuses the same step, and this sentence
    // names the field where that refusal names none.
    const ignored = ignoredStepField(raw)
    if (ignored !== undefined) throw new Error(stepRefusal(at + 1, ignoredFieldReason(ignored)))
    if (readActComponentStep(raw) === undefined) throw new Error(stepRefusal(at + 1, STEP_REFUSAL_TEXT))
  }
}

/**
 * Turn one posted report of steps into the call's answer.
 * @param outcome - what the claiming console reported, in the shared channel's own vocabulary.
 * @returns the canonical value for steps that ran.
 */
function valueOf(outcome: ActOutcome): ActComponentValue {
  return {
    status: outcome.status,
    entry: outcome.page,
    steps: outcome.steps.map(step => ({
      index: step.index,
      status: step.status,
      ...step.status === 'failed' ? { message: step.message } : {},
    })),
    text: outcome.text,
  }
}

/** The `steps` parameter as the model's schema declares it. */
const STEPS_PARAMETER = {
  type: 'array' as const,
  required: true as const,
  description: STEPS_DESCRIPTION,
  items: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      action: { type: 'string' as const, enum: [...ACT_COMPONENT_ACTIONS], required: true as const, description: ACTION_DESCRIPTION },
      node: { type: 'string' as const, description: NODE_DESCRIPTION },
      key: { type: 'string' as const, description: KEY_DESCRIPTION },
      row: { type: 'string' as const, description: ROW_DESCRIPTION },
      name: { type: 'string' as const, description: NAME_DESCRIPTION },
      value: { type: 'string' as const, description: VALUE_DESCRIPTION },
      timeoutMs: { type: 'integer' as const, description: TIMEOUT_DESCRIPTION },
    },
  },
}

/**
 * Build the `act_component` tool for one deployment.
 * @param calls - the channel table this domain's calls wait in.
 * @param timeouts - the deployment's deadlines, also quoted in the timeout answers.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function actComponentTool(calls: CallTable, timeouts: CallTimeouts): ToolDefinition {
  return defineTool({
    name: ACT_COMPONENT_TOOL_NAME,
    description: ACT_COMPONENT_DESCRIPTION,
    parameters: {
      entry: { type: 'string', required: true, description: ENTRY_DESCRIPTION },
      steps: STEPS_PARAMETER,
    },
    output: {
      // Deliberately parallel to the page domain's `content_act` output schema
      // in `content-frame`: both answer "which step ran, which one stopped the
      // call", with each domain's own step vocabulary and bounds. The two
      // cannot share a declaration: this package takes only types from
      // `content-frame`, for the reason the content channel Agent Note
      // (2026-10-09-content-channel-seam-and-duplication) records.
      /* jscpd:ignore-start */
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            enum: ['done', 'failed', 'unverified'],
            required: true,
            description: 'Whether every step ran, one stopped the call, or the console never reported.',
          },
          entry: {
            type: 'object',
            additionalProperties: false,
            description: 'The component entry the steps ran on.',
            properties: {
              id: { type: 'string', required: true, description: 'The entry id the call named.' },
              title: { type: 'string', required: true, description: 'The title the column shows for it.' },
            },
          },
          steps: {
            type: 'array',
            required: true,
            description: 'One entry per requested step, in order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true, description: 'Which step, counting from 1.' },
                status: {
                  type: 'string',
                  enum: ['ok', 'failed', 'skipped'],
                  required: true,
                  description: 'Whether it ran, stopped the call, or never ran.',
                },
                message: { type: 'string', description: 'Why it failed; only the step that stopped the call has one.' },
              },
            },
          },
          text: {
            type: 'string',
            required: true,
            description: 'What ran, and what the entry\'s own controls answered.',
          },
        },
      },
      /* jscpd:ignore-end */
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({ entry: value.entry?.title ?? '' }),
    },
    // Two calls acting on one entry at once would interleave their steps in a
    // document neither of them read; the registry runs this alone.
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<ActComponentValue> {
      // Read before the wait opens: a call whose steps this tool cannot read is
      // one no console should be asked to run.
      checkActArgs(args)
      // A claimed call that never reported is a value rather than a rejection:
      // the console took the call, so the steps may have run in full, in part,
      // or not at all, and only the console can say which.
      return await settleChannelCall(
        calls,
        timeouts,
        exec,
        SETTLE_TEXT,
        outcome => (isActComponentReport(outcome) ? valueOf(outcome) : undefined),
        { status: 'unverified', steps: [], text: unverifiedRefusal(timeouts.answerTimeoutMs) },
      )
    },
    presentCall: (args) => {
      const parsed = parseActComponentArgs(args)
      return channelCallCard(CALL_TITLE, args, parsed === undefined ? undefined : `${parsed.entry}: ${String(parsed.steps.length)} step(s)`)
    },
    presentResult: (_args, result) => channelResultCard(CALL_TITLE, result),
  })
}
