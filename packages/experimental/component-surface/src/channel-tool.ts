/**
 * What `act_component` and `read_component` share on the host: opening one
 * call on the content channel and turning how it settled into the tool's
 * answer, and the two cards a call is drawn with.
 *
 * Each tool keeps its own sentences and its own reading of a report; what
 * this module holds is the order both settle in, so the two cannot drift
 * apart on which ending rejects and which one answers.
 * @module @deepseek-ai/dsh-experimental-component-surface/channel-tool
 */

import type { GenericCallView, GenericResultView, ToolResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CallTable, CallTimeouts } from '@deepseek-ai/dsh-experimental-content-frame/src/access/pending.ts'
import type { ChannelOutcome } from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'

/**
 * How much of the raw arguments a call card prints for a call its tool could
 * not read. Long enough to show what was asked for, short enough that a card
 * is not a transcript.
 */
const MAX_RAW_INPUT_CHARS = 200

/** The sentences one channel tool rejects with, each in that tool's own words. */
export interface ChannelToolText {
  /** Refusal for a call with no owning session, which has no column to reach. */
  readonly noAgent: string
  /** Refusal for a report that answers the call with another tool's document. */
  readonly misreported: string
  /** Refusal for a call the runtime cancelled while it waited. */
  readonly cancelled: string
  /**
   * Refusal for a call no console claimed.
   * @param claimTimeoutMs - how long the call waited.
   * @returns the model-facing sentence.
   */
  unclaimed(claimTimeoutMs: number): string
  /**
   * The rejection one posted refusal turns into.
   * @param message - the refusal the console posted.
   * @returns the model-facing sentence.
   */
  failure(message: string): string
}

/**
 * Open one call on the channel and settle it as the tool's answer.
 *
 * A report the tool reads is the answer, and so is the tool's own value for a
 * console that claimed the call and never reported: its steps or its reading
 * may have happened, and only the console could say. Every other ending
 * rejects with the tool's own sentence — no session, a console's refusal, a
 * report answering another tool, no claim, and the runtime's cancellation,
 * whose message exists for a caller reading the rejection directly, since the
 * registry replaces it with its aborted result.
 * @param calls - the channel table the call waits in.
 * @param timeouts - the deployment's deadlines, also quoted in the refusals.
 * @param exec - the execution the call belongs to.
 * @param text - the tool's own sentences.
 * @param read - the tool's reading of a report: its answer, or `undefined` for a document another tool posts.
 * @param unanswered - the answer for a claimed call that never reported.
 * @returns the answer.
 * @throws {Error} with the tool's own sentence for every ending that is not an answer.
 */
export async function settleChannelCall<Value>(
  calls: CallTable,
  timeouts: CallTimeouts,
  exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>,
  text: ChannelToolText,
  read: (outcome: ChannelOutcome) => Value | undefined,
  unanswered: Value,
): Promise<Value> {
  // The entry belongs to a session's column, and the pending list a browser
  // reads is that session's projection.
  if (!exec.agent) throw new Error(text.noAgent)
  const settlement = await calls.open(exec.callId, exec.agent.session.header.id, exec.signal, timeouts)
  switch (settlement.kind) {
    case 'reported': {
      const outcome = settlement.outcome
      if (outcome.status === 'error') throw new Error(text.failure(outcome.message))
      const answer = read(outcome)
      if (answer === undefined) throw new Error(text.misreported)
      return answer
    }
    case 'unclaimed': throw new Error(text.unclaimed(timeouts.claimTimeoutMs))
    case 'unanswered': return unanswered
    case 'aborted': throw new Error(text.cancelled)
    /* v8 ignore start -- CallSettlement is closed and every variant returns or throws above. */
    default: {
      // Not `assertNever` from dsh-llm, for the reason tool.ts states at its
      // own exhaustiveness check.
      const unhandled: never = settlement
      throw new Error(`component-surface: unhandled call settlement ${JSON.stringify(unhandled)}`)
    }
    /* v8 ignore stop */
  }
}

/**
 * The card a pending or settled call is drawn with.
 *
 * Display only, and it runs on replay of whatever was logged, so the caller
 * summarizes the arguments with the reading that answers `undefined` rather
 * than with the body's own, which throws.
 * @param title - the tool's card title.
 * @param args - the arguments as logged.
 * @param summary - the tool's one-line summary of the arguments, absent where its reading refused them.
 * @returns the card, printing the raw arguments cut short where there is no summary.
 */
export function channelCallCard(title: string, args: unknown, summary: string | undefined): GenericCallView {
  const raw = JSON.stringify(args)
  return {
    card: 'generic',
    title,
    kind: 'other',
    rawInput: summary ?? (raw.length > MAX_RAW_INPUT_CHARS ? `${raw.slice(0, MAX_RAW_INPUT_CHARS)}…` : raw),
  }
}

/**
 * The card a settled call is drawn with: the first line of what the model was told.
 * @param title - the tool's card title, for a result that carries no text.
 * @param result - the settled result.
 * @returns the card.
 */
export function channelResultCard(title: string, result: ToolResult): GenericResultView {
  return { card: 'generic', title: result.content.find(block => block.type === 'text')?.text.split('\n')[0] ?? title }
}
