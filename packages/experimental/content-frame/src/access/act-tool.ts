/**
 * `content_act` — the agent acts on the page the user is looking at.
 *
 * The body runs nothing itself. It validates the steps, waits for a browser
 * seat showing this session to claim the call, and answers with what that seat
 * reports: which steps ran, what the page did while they ran, and how the page
 * reads afterwards. Every step therefore happens in the document the user has
 * in front of them, under that document's own event handlers, and nothing about
 * the result is composed from what the host expected to happen.
 *
 * A step that fails is a value, not a rejection: the call stops there, the rest
 * are reported as skipped, and the model reads which step stopped it and why in
 * the same answer that carries the page's new state. Only the endings where
 * nothing ran at all — no console, no page, refused arguments — reject.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/act-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CallTimeouts, PendingCalls } from './pending.ts'
import type { DialogApprovals } from './dialog-approvals.ts'
import {
  ACT_VOICE, ACTION_DESCRIPTION, approvalReason, CANCELLED_REFUSAL, CONTENT_ACT_DESCRIPTION,
  DIALOGS_DESCRIPTION, DIALOGS_UNAPPROVED_REFUSAL, KEY_DESCRIPTION, LABEL_DESCRIPTION, MARK_DESCRIPTION,
  NO_AGENT_REFUSAL, NO_STEPS_REFUSAL, NOTHING_DONE, REF_DESCRIPTION, STEPS_DESCRIPTION, stepRefusal,
  stepRefusalText, TEXT_DESCRIPTION, tooManyStepsRefusal, unverifiedRefusal, VALUE_DESCRIPTION,
} from './act-text.ts'
import { failureRefusal, MISREPORTED_REFUSAL, unclaimedRefusal } from './text.ts'
import {
  ACT_ACTIONS, CONTENT_ACT_TOOL_NAME, DIALOG_ANSWERS, isActOutcome, parseActArgs, readActStep, type ActArgs,
  type ActOutcome, type ActStep, type ActStepResult,
} from './wire.ts'
import type { FrontEntryLookup } from './read-value.ts'

/** Title of the call card, in the pending and the settled state alike. */
const CALL_TITLE = 'Act on the page in the content column'

/**
 * How much of the raw arguments the call card prints for a call this tool could
 * not read as steps. Long enough to show which steps were asked for, short
 * enough that a card is not a transcript.
 */
const MAX_RAW_INPUT_CHARS = 200

/** The canonical outcome declared by the `content_act` output schema. */
export interface ContentActValue {
  /**
   * Whether every step ran, one of them stopped the call, or the console that
   * took the call never said.
   */
  status: 'done' | 'failed' | 'unverified'
  /** The page the steps ran on; absent when no console reported. */
  page?: { id: string; title: string }
  /** The document's own title afterwards; absent when no console reported. */
  title?: string
  /** One entry per requested step, in order; empty when no console reported. */
  steps: { index: number; status: 'ok' | 'failed' | 'skipped'; message?: string }[]
  /** What ran, what the page did on its own, and how the page reads now. */
  text: string
  /** True when the closing reading of the page stops short of everything it would have shown. */
  truncated: boolean
}

/** The arguments as the tool's own schema hands them over. */
interface RawArgs {
  /** The steps, in the order they would run. */
  readonly steps: readonly unknown[]
  /** How a native dialog is answered while they run. */
  readonly dialogs?: string
}

/**
 * Take the model's arguments as steps the seat can run, or say what is wrong
 * with them.
 *
 * The reading itself is the wire's, so what a seat receives and what the
 * approval request describes are the same steps this refuses over; what this
 * adds is the sentence — which step, and which parameter of it to fix.
 * @param args - the arguments as the schema validated them.
 * @param maxSteps - the deployment's bound on how many steps one call has.
 * @returns the validated arguments.
 * @throws {Error} naming the step and the parameter to fix.
 */
function actArgs(args: RawArgs, maxSteps: number): ActArgs {
  if (args.steps.length === 0) throw new Error(NO_STEPS_REFUSAL)
  if (args.steps.length > maxSteps) throw new Error(tooManyStepsRefusal(maxSteps))
  const steps = args.steps.map((raw, at): ActStep => {
    const read = readActStep(raw as Parameters<typeof readActStep>[0])
    if (read.kind === 'refusal') throw new Error(stepRefusal(at + 1, stepRefusalText(read.refusal)))
    return read.step
  })
  const dialogs = DIALOG_ANSWERS.find(known => known === args.dialogs)
  return { steps, ...dialogs === undefined ? {} : { dialogs } }
}

/**
 * Turn one posted outcome into the call's answer.
 * @param outcome - what the claiming seat reported.
 * @returns the canonical value for steps that ran.
 */
function valueOf(outcome: ActOutcome): ContentActValue {
  return {
    status: outcome.status,
    page: outcome.page,
    title: outcome.title,
    steps: outcome.steps.map((step: ActStepResult) => ({
      index: step.index,
      status: step.status,
      ...step.status === 'failed' ? { message: step.message } : {},
    })),
    text: outcome.text,
    truncated: outcome.truncated,
  }
}

/**
 * Build the `content_act` tool for one deployment.
 * @param pending - the table calls wait on for a browser to answer them.
 * @param timeouts - the deployment's deadlines, also quoted in the timeout answer.
 * @param maxSteps - the deployment's bound on how many steps one call has.
 * @param front - reads the entry the calling session's column has in front, for the unclaimed refusal.
 * @param approvals - the call ids whose approval request said a native dialog would be confirmed.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function contentActTool(
  pending: PendingCalls,
  timeouts: CallTimeouts,
  maxSteps: number,
  front: FrontEntryLookup,
  approvals: DialogApprovals,
): ToolDefinition {
  return defineTool({
    name: CONTENT_ACT_TOOL_NAME,
    description: CONTENT_ACT_DESCRIPTION,
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: STEPS_DESCRIPTION,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: [...ACT_ACTIONS], required: true, description: ACTION_DESCRIPTION },
            ref: { type: 'string', description: REF_DESCRIPTION },
            label: { type: 'string', description: LABEL_DESCRIPTION },
            mark: { type: 'string', description: MARK_DESCRIPTION },
            text: { type: 'string', description: TEXT_DESCRIPTION },
            value: { type: 'string', description: VALUE_DESCRIPTION },
            key: { type: 'string', description: KEY_DESCRIPTION },
          },
        },
      },
      dialogs: { type: 'string', enum: [...DIALOG_ANSWERS], description: DIALOGS_DESCRIPTION },
    },
    output: {
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
          page: {
            type: 'object',
            additionalProperties: false,
            description: 'The page the steps ran on.',
            properties: {
              id: { type: 'string', required: true, description: 'The id content_show names this page by.' },
              title: { type: 'string', required: true, description: 'The page\'s configured title.' },
            },
          },
          title: { type: 'string', description: 'The document\'s own title after the steps.' },
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
            description: 'What ran, what the page did on its own, and how the page reads now.',
          },
          truncated: {
            type: 'boolean',
            required: true,
            description: 'Whether the closing reading of the page stops short of the whole page.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      // The transcript row names the page the steps ran on; the body is written
      // for the model rather than for a reader.
      presentationMeta: (_args, value) => ({ page: value.page?.title ?? '' }),
    },
    // Two calls acting on one page at once would interleave their steps in a
    // document neither of them read; the registry runs this alone.
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<ContentActValue> {
      const parsed = actArgs(args, maxSteps)
      // The column is per-session state, and the pending list a browser reads
      // is that session's projection; a caller with no owning session has no
      // column to act on.
      if (!exec.agent) throw new Error(NO_AGENT_REFUSAL)
      // A standing allowance, a policy that never asks, or any other path that
      // reaches this body without the request the user actually read is what
      // this refuses: confirming the page's own dialog is only ever done under
      // an approval that said so.
      if (parsed.dialogs === 'accept' && !approvals.confirmed(exec.callId)) {
        throw new Error(DIALOGS_UNAPPROVED_REFUSAL)
      }
      // Read here rather than earlier: the wait opens once the user has
      // answered the approval, so this is the entry they were looking at when
      // they agreed to these steps, and it is what the seat holds the column to.
      const approved = front(exec.agent.session)
      const settlement = await pending.open(
        exec.callId,
        exec.agent.session.header.id,
        exec.signal,
        timeouts,
        approved === undefined ? undefined : { id: approved.entryId, title: approved.title },
      )
      switch (settlement.kind) {
        case 'reported': {
          // Three arms reach here. Steps that ran are the answer; the listing
          // channel's failure arm is how the seat says there was no page to
          // run them on, which is the same set of endings a read has; and a
          // listing answering a call that asked for steps is no answer at all.
          const outcome = settlement.outcome
          if (isActOutcome(outcome)) return valueOf(outcome)
          if (outcome.status === 'ok') throw new Error(MISREPORTED_REFUSAL)
          throw new Error(failureRefusal(outcome, ACT_VOICE))
        }
        case 'unclaimed': {
          throw new Error(`${unclaimedRefusal(timeouts.claimTimeoutMs, front(exec.agent.session))}${NOTHING_DONE}`)
        }
        // The one ending that is a value rather than a rejection without a step
        // having run: the console took the call, so the steps may have run in
        // full, in part, or not at all, and only the page can say which.
        case 'unanswered': return {
          status: 'unverified',
          steps: [],
          text: unverifiedRefusal(timeouts.answerTimeoutMs),
          truncated: false,
        }
        // Whatever this returns is replaced by the registry's aborted result;
        // the message exists for a caller reading the rejection directly.
        case 'aborted': throw new Error(CANCELLED_REFUSAL)
        /* v8 ignore next 2 -- the settlement union is closed and typed; the arm keeps a new member loud. */
        default: throw new Error(`content_act: unknown settlement ${JSON.stringify(settlement)}`)
      }
    },
    // Display only, and it runs on replay of whatever was logged, so it reads
    // the arguments with the parser that answers `undefined` rather than with
    // the body's own, which throws: a call the body refused for a missing field
    // is a call this would otherwise throw on every time it was rendered.
    presentCall: (args): GenericCallView => {
      const parsed = parseActArgs(args)
      const raw = JSON.stringify(args)
      return {
        card: 'generic',
        title: CALL_TITLE,
        kind: 'other',
        rawInput: parsed === undefined
          ? (raw.length > MAX_RAW_INPUT_CHARS ? `${raw.slice(0, MAX_RAW_INPUT_CHARS)}…` : raw)
          : approvalReason(parsed),
      }
    },
    presentResult: (_args, result): GenericResultView => ({
      card: 'generic',
      title: result.content.find(block => block.type === 'text')?.text.split('\n')[0] ?? CALL_TITLE,
    }),
  })
}
