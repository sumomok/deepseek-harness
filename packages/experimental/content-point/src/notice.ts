/**
 * The messages a step enters with: after each user message carrying this
 * plugin's references, one logged user message writing them, unless the step
 * already holds it.
 * @module @deepseek-ai/dsh-experimental-content-point/notice
 */

import { MAX_PROMPT_REFERENCES } from '@deepseek-ai/dsh-attachment'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: the `user-rpc` source a browser prompt's references are recorded on.
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { pointNotice } from './text.ts'
import type { RecordedReference } from './text.ts'

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
