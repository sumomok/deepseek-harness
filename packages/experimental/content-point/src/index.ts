/**
 * @deepseek-ai/dsh-experimental-content-point — 「指一下」: the user points at a
 * place in the content column or the sidebar, and the model is told where.
 *
 * The browser half (`./client`) puts a button in the composer's tool row; a
 * click starts `@haoran/dsh-point-anchor`'s picker over the console document,
 * and the place clicked becomes a reference draft in the attachment row, filed
 * under {@link POINT_SOURCE}. Its `data` is point-anchor's description of the
 * place without the DataPage row, or, for a block point-anchor does not
 * describe, a block reference (`./block`). The send records the references on
 * the accepted user message's source; no provider request carries a source.
 *
 * This host half makes them model-visible. Before each step it reads the user
 * messages entering it and, after each one carrying references of
 * {@link POINT_SOURCE}, appends one logged user message whose text writes each
 * of them — at most `MAX_PROMPT_REFERENCES` — with its key line and display
 * text and no row value. The appended message's source is the
 * `content-point` kind this module declares, naming the message it answers, so
 * a step that already holds it appends nothing more. It appends no session
 * event and writes no `content-component/shown`.
 * @module @deepseek-ai/dsh-experimental-content-point
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { MAX_PROMPT_REFERENCES } from '@deepseek-ai/dsh-attachment'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: the `user-rpc` source a browser prompt's references are recorded on.
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { pointNotice } from './text.ts'
import type { RecordedReference } from './text.ts'

export { POINT_SOURCE } from './text.ts'
export { BLOCK_FORMAT, BLOCK_KIND, blockData, blockKey, blockLabel, parseBlockData } from './block.ts'
export type { BlockData, BlockParsed, BlockPlace, BlockProblem, BlockShown } from './block.ts'

/** The `MessageSource` kind of the message this plugin appends. */
export const POINT_MESSAGE_KIND = 'content-point'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The text this package appends after a user message carrying its points: one paragraph per point, its key line and
     * display text. Readers preserve the content without this producer.
     * @persistenceAttribution
     */
    'content-point': {
      kind: 'content-point'
      /** The user message whose points it writes. */
      message: MessageId
    } & ContextFormed
  }
}

/** Stable Cordis plugin name. */
export const name = 'content-point'

/**
 * The references a user message's source records, when it records any.
 * @param message - the message.
 * @returns the references, empty for a message that records none.
 */
function recordedReferences(message: UserMessage): readonly RecordedReference[] {
  const source = message.source
  return source.kind === 'user' && 'references' in source ? source.references : []
}

/**
 * The messages that enter a step with this plugin's text after each user
 * message carrying its points, unless the step already holds that text.
 * @param messages - the step's messages, in order.
 * @returns the messages with the appended text, or the same array when nothing is appended.
 */
export function withPointNotices(messages: readonly UserMessage[]): UserMessage[] {
  const answered = new Set<MessageId>()
  for (const message of messages) {
    if (message.source.kind === POINT_MESSAGE_KIND) answered.add(message.source.message)
  }
  const result: UserMessage[] = []
  let appended = false
  for (const message of messages) {
    result.push(message)
    if (answered.has(message.id)) continue
    const notice = pointNotice(recordedReferences(message), MAX_PROMPT_REFERENCES)
    if (notice === undefined) continue
    result.push(createUserMessage({
      content: [{ type: 'text', text: notice.text }],
      source: { kind: POINT_MESSAGE_KIND, message: message.id, form: 'notice', summary: boundContextSummary(`指着：${notice.labels.join('、')}`) },
    }))
    answered.add(message.id)
    appended = true
  }
  return appended ? result : [...messages]
}

/**
 * Append the text of each user message's points before the step it enters.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return { ...decision, messages: withPointNotices(decision.messages) }
  })
}
