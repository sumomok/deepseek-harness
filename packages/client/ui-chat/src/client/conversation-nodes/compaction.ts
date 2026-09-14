import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  CompactionSummaryNode, ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { CompactionFailureChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'
import { compactSource, compactSummary, updateCompactionState } from './command.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Automatic compaction checkpoint marker. */
    compaction: CompactionSummaryNode
    /** Automatic compaction bracket that closed without replacing any history. */
    'compaction-failure': CompactionFailureChatData
  }
}

interface CompactionState {
  readonly summary?: ConversationMatch
  readonly checkpoint?: ConversationMatch
  readonly failure?: ConversationMatch
}

/**
 * Renderings `errorChain` produces for a cancelled compaction, as a lowercase
 * substring of the chain's leading segment. `compaction/end` records only that
 * text — the `ABORTED` code the summarizer carried is not on the event — so
 * this is the whole of the remaining evidence.
 *
 * Every shipped source of a cancelled summarization spells the word: the
 * DeepSeek and pi-ai adapters raise `… request aborted by caller`, the pi-ai
 * stream `pi-ai stream aborted`, and a bare `AbortSignal` reason renders as
 * `This operation was aborted` or, with an empty message, as `AbortError`.
 *
 * The accepted cost is that a genuine provider failure whose own wording
 * contains the word is read as a cancellation and shown to nobody. That is the
 * safer direction: a card the user's own Stop produced is worse than a missing
 * card for a rare upstream abort, which the host still logs.
 */
const CANCELLED_COMPACTION_MARKER = 'abort'

/**
 * Renderings that name no failure, so the card falls back to locale copy.
 * `errorChain` renders a thrown non-Error through `String(value)`, which turns
 * a plain object into `[object Object]`, and collapses a value with hostile
 * accessors into a fixed marker.
 *
 * These are failures, not cancellations: an `AgentCancelCause` does reach
 * `String(value)` the same way, but not on this path. The shipped adapters
 * rewrite an aborted request into `… request aborted by caller` before it can
 * propagate, so a cancelled summarization always arrives as text the marker
 * above catches, and what lands here is an opaque throw from somewhere else.
 */
const UNUSABLE_REASONS: readonly string[] = ['[object Object]', '<unrenderable value>']

/**
 * Read the failure text an errored `compaction/end` carries. A bracket that
 * commits its replacement closes cleanly, so this is the durable evidence that
 * a compaction ran and changed nothing.
 *
 * @returns `undefined` when the event is not an errored end or records a
 *   cancellation, `null` when it names no usable reason, otherwise the text.
 */
function failureReason(event: SessionEventLike): string | null | undefined {
  if (event.type !== 'compaction/end') return undefined
  const error: unknown = event.data.error
  if (error === undefined) return undefined
  if (typeof error !== 'string' || error.trim() === '') return null
  const leading = error.split(': ')[0] ?? error
  if (leading.toLowerCase().includes(CANCELLED_COMPACTION_MARKER)) return undefined
  return UNUSABLE_REASONS.includes(error.trim()) ? null : error
}

function fallbackState(context: ConversationNodeContext<CompactionState>): CompactionState {
  const summary = context.matches.find(match => match.event.type === 'compaction/summary')
  const checkpoint = context.matches.find(match => compactSource(match.event) !== undefined)
  const failure = context.matches.find(match => failureReason(match.event) !== undefined)
  return {
    ...summary === undefined ? {} : { summary },
    ...checkpoint === undefined ? {} : { checkpoint },
    ...failure === undefined ? {} : { failure },
  }
}

/**
 * Automatic compaction lifecycle, landed checkpoint, and failed-bracket
 * Definition.
 *
 * Known limitation: each compaction is its own Context, keyed by its
 * `compactionId`, so a summarizer that stays down puts one failure card in the
 * transcript per step it is retried. Collapsing them would need a Definition to
 * suppress another Context's node, which this framework does not offer, and
 * the engine applies no backoff of its own between steps.
 */
export const compactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'compaction',
  target: 'chat',
  match: (event) => {
    const checkpoint = compactSource(event)
    if (checkpoint !== undefined && checkpoint.sourceCommandId === undefined) {
      return { id: checkpoint.compactionId, role: 'update' }
    }
    if (event.type === 'compaction/start'
      || event.type === 'compaction/summary'
      || event.type === 'compaction/end') {
      if (event.data.sourceCommandId !== undefined) return null
      const compactionId: unknown = event.data.compactionId
      if (typeof compactionId !== 'string' || compactionId === '') return null
      return { id: compactionId, role: event.type === 'compaction/start' ? 'start' : 'update' }
    }
    return null
  },
  start: () => ({}),
  update: (context, match) => (
    failureReason(match.event) === undefined
      ? updateCompactionState(context.state, match)
      : { ...context.state, failure: match }
  ),
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state.checkpoint !== undefined) {
      const marker = compactSummary(state.summary, state.checkpoint)
      return chatNode(context, 'compaction', marker.seq, marker)
    }
    if (state.failure === undefined) return null
    const event = state.failure.event
    const data: CompactionFailureChatData = { reason: failureReason(event) ?? null }
    return chatNode(context, 'compaction-failure', event.seq, data)
  },
}

/**
 * Register the automatic-compaction business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerCompactionConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(compactionDefinition)
}
