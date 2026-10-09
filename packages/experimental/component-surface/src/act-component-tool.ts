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
import type { GenericCallView, GenericResultView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CallTable, CallTimeouts } from '@deepseek-ai/dsh-experimental-content-frame/src/access/pending.ts'
import type { ActOutcome, ChannelOutcome } from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'
import {
  ACT_COMPONENT_ACTIONS, ACT_COMPONENT_TOOL_NAME, MAX_ACT_COMPONENT_STEPS, MAX_SET_VALUE_CHARS, MAX_TARGET_CHARS,
  MAX_WAIT_MS, parseActComponentArgs, readActComponentStep,
  type ActComponentArgs, type ActComponentStep, type ActComponentStepResult,
} from './act-component-call.ts'
import { MAX_ENTRY_ID_LENGTH } from './component-call.ts'
import {
  ACTION_DESCRIPTION, ACT_COMPONENT_DESCRIPTION, BAD_ENTRY_REFUSAL, CANCELLED_REFUSAL, ENTRY_DESCRIPTION,
  KEY_DESCRIPTION, MISREPORTED_REFUSAL, NAME_DESCRIPTION, NODE_DESCRIPTION, NO_AGENT_REFUSAL, NO_STEPS_REFUSAL,
  STEP_REFUSAL_TEXT, STEPS_DESCRIPTION, TIMEOUT_DESCRIPTION, VALUE_DESCRIPTION, failureRefusal, stepRefusal,
  tooManyStepsRefusal, unclaimedRefusal, unverifiedRefusal,
} from './act-component-text.ts'

/** Title of the call card, in the pending and the settled state alike. */
const CALL_TITLE = 'Act inside the component in the content panel'

/**
 * How much of the raw arguments the call card prints for a call this tool could
 * not read as steps. Long enough to show which steps were asked for, short
 * enough that a card is not a transcript.
 */
const MAX_RAW_INPUT_CHARS = 200

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
 * Take the model's arguments as steps a console can run, or say what is wrong
 * with them.
 *
 * The reading itself is the shared module's, so what a browser runs and what
 * this refuses over are one reading; what this adds is the sentence — which
 * step, and which parameter to fix.
 * @param args - the arguments as the schema validated them.
 * @param maxSteps - this deployment's ceiling on how many steps one call has.
 * @returns the validated arguments.
 * @throws {Error} naming the step and the parameter to fix.
 */
function actArgs(args: unknown, maxSteps: number): ActComponentArgs {
  const candidate = args as { entry?: unknown; steps?: unknown }
  if (typeof candidate?.entry !== 'string' || candidate.entry.length === 0 || candidate.entry.length > MAX_ENTRY_ID_LENGTH) {
    throw new Error(BAD_ENTRY_REFUSAL)
  }
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) throw new Error(NO_STEPS_REFUSAL)
  if (candidate.steps.length > maxSteps) throw new Error(tooManyStepsRefusal(maxSteps))
  const steps = candidate.steps.map((raw, at): ActComponentStep => {
    const step = readActComponentStep(raw)
    if (step === undefined) throw new Error(stepRefusal(at + 1, STEP_REFUSAL_TEXT))
    return step
  })
  return { entry: candidate.entry, steps }
}

/**
 * Turn one posted outcome into the call's answer.
 * @param outcome - what the claiming console reported, in the shared channel's own vocabulary.
 * @returns the canonical value for steps that ran.
 */
function valueOf(outcome: ActOutcome): ActComponentValue {
  return {
    status: outcome.status,
    entry: outcome.page,
    steps: outcome.steps.map((step: ActComponentStepResult) => ({
      index: step.index,
      status: step.status,
      ...step.status === 'failed' ? { message: step.message } : {},
    })),
    text: outcome.text,
  }
}

/**
 * Whether one settled call's outcome reports steps that ran.
 *
 * The channel module offers the same test and this file does not take it: a
 * value imported from another plugin would put a second copy of the channel's
 * wire layer inside this package's host bundle. The test is a discriminant
 * check, and the channel keeps the one the deployment actually runs.
 * @param outcome - what the call settled as.
 * @returns whether it reports steps rather than anything a page read answers with.
 */
function reportsSteps(outcome: ChannelOutcome): outcome is ActOutcome {
  return outcome.status === 'done' || outcome.status === 'failed'
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
 * @param maxSteps - the deployment's ceiling on how many steps one call has.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function actComponentTool(calls: CallTable, timeouts: CallTimeouts, maxSteps: number): ToolDefinition {
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
      // cannot share a declaration for the reason the folds cannot — a value
      // import across these packages is refused for the client bundle and
      // inlines a second copy of the channel in the host one.
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
      actArgs(args, maxSteps)
      // The entry belongs to a session's column, and the pending list a browser
      // reads is that session's projection; a caller with no session has no
      // column to act on.
      if (!exec.agent) throw new Error(NO_AGENT_REFUSAL)
      const settlement = await calls.open(exec.callId, exec.agent.session.header.id, exec.signal, timeouts)
      switch (settlement.kind) {
        case 'reported': {
          // Two kinds of arm reach here. Steps that ran are the answer, which is
          // the same document a call that ran steps on a page answers with; the
          // failure arm is how the console says there was no entry to run them
          // on. Anything a page read answers with is no answer to this call.
          const outcome = settlement.outcome
          if (reportsSteps(outcome)) return valueOf(outcome)
          if (outcome.status !== 'error') throw new Error(MISREPORTED_REFUSAL)
          throw new Error(failureRefusal(outcome.message))
        }
        case 'unclaimed': throw new Error(unclaimedRefusal(timeouts.claimTimeoutMs))
        // The one ending that is a value rather than a rejection without a step
        // having run: the console took the call, so the steps may have run in
        // full, in part, or not at all, and only the console can say which.
        case 'unanswered': return {
          status: 'unverified',
          steps: [],
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
      const parsed = parseActComponentArgs(args)
      const raw = JSON.stringify(args)
      return {
        card: 'generic',
        title: CALL_TITLE,
        kind: 'other',
        rawInput: parsed === undefined
          ? (raw.length > MAX_RAW_INPUT_CHARS ? `${raw.slice(0, MAX_RAW_INPUT_CHARS)}…` : raw)
          : `${parsed.entry}: ${String(parsed.steps.length)} step(s)`,
      }
    },
    presentResult: (_args, result): GenericResultView => ({
      card: 'generic',
      title: result.content.find(block => block.type === 'text')?.text.split('\n')[0] ?? CALL_TITLE,
    }),
  })
}

/** The bounds this tool's arguments are read against, for the offer that names them. */
export const ACT_COMPONENT_BOUNDS = {
  /** Ceiling on steps one call may carry. */
  maxSteps: MAX_ACT_COMPONENT_STEPS,
  /** Longest a named block, key, or field name may be. */
  maxTargetChars: MAX_TARGET_CHARS,
  /** Longest a written value may be. */
  maxValueChars: MAX_SET_VALUE_CHARS,
  /** Longest a wait may last, in milliseconds. */
  maxWaitMs: MAX_WAIT_MS,
} as const

/** The step type this module's tool takes, re-exported for a reader of the offer. */
export type { ActComponentStep }
