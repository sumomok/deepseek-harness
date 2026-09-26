/**
 * An in-memory inbox for this package's fake agents. The concrete agent-loop
 * Inbox is internal to that package, and its test kit mounts the host
 * AgentLoop, which this Client test program must not load. Only the queue
 * operations the component-action handler and these specs reach are live.
 */

import type { Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/** Pending messages per boundary, with the replace-while-pending rule the handler relies on. */
class QueueInbox implements Inbox {
  private readonly queues = new Map<InboxTarget, UserMessage[]>([['next-turn', []], ['next-step', []]])

  get nextTurn(): readonly UserMessage[] { return this.queue('next-turn') }
  get nextStep(): readonly UserMessage[] { return this.queue('next-step') }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: readonly UserMessage[]): UserMessage[] {
    return this.queue(target).splice(start, deleteCount, ...inserted)
  }

  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    for (const queue of this.queues.values()) {
      const at = queue.findIndex(message => message.id === messageId)
      if (at === -1) continue
      queue[at] = newMessage
      return true
    }
    return false
  }

  clear(): never { return unsupported('clear') }
  append(): never { return unsupported('append') }
  prepend(): never { return unsupported('prepend') }
  remove(): never { return unsupported('remove') }

  private queue(target: InboxTarget): UserMessage[] {
    const queue = this.queues.get(target)
    if (queue === undefined) throw new Error(`queue inbox: no ${target} queue`)
    return queue
  }
}

/**
 * Reject an Inbox operation these specs never reach.
 * @param operation - the Inbox method name.
 * @returns never; always throws.
 */
function unsupported(operation: string): never {
  throw new Error(`queue inbox: ${operation} is not used by these specs`)
}

/**
 * Create an empty in-memory inbox.
 * @returns an Inbox whose `splice`, `replace`, `nextStep` and `nextTurn` are live.
 */
export function createQueueInbox(): Inbox {
  return new QueueInbox()
}
