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
 * Read the failure text an errored `compaction/end` carries. A bracket that
 * commits its replacement closes cleanly, so this is the durable evidence that
 * a compaction ran and changed nothing.
 */
function failureReason(event: SessionEventLike): string | null | undefined {
  if (event.type !== 'compaction/end') return undefined
  const error: unknown = event.data.error
  if (error === undefined) return undefined
  return typeof error === 'string' && error.trim() !== '' ? error : null
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

/** Automatic compaction lifecycle and landed checkpoint Definition. */
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
    const data: CompactionFailureChatData = {
      seq: event.seq,
      time: event.time,
      reason: failureReason(event) ?? null,
    }
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
