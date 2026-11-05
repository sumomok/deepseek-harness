/**
 * Resolve one durable message position to the Chat row that renders it.
 *
 * A Chat row is not one event: an Assistant row anchors at its first visible
 * chunk (`anchorSeq`), while the message the search index reports is the
 * later settlement event, so an equality test against `anchorSeq` misses it.
 * The resolution therefore reads the message identity a row carries when it
 * has one, and otherwise picks the last row the message's own Location
 * (Turn, then Step) had already opened — the interval that event falls in.
 */
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ChatNode } from './chat-nodes.ts'
import { isVisibleChatNode } from './chat-visibility.ts'
import type { ChatSnapshot } from './snapshot.ts'

/** One reveal this view could not place, and why. */
export interface ChatRevealFailureReport {
  /** Which stage failed. */
  readonly reason: ChatRevealFailure
  /** Durable position the navigation asked for. */
  readonly seq: SessionSeq
}

/** Why one reveal could not place its message. */
export type ChatRevealFailure =
  /** The history page holding the message never arrived. */
  | 'history'
  /** The loaded window has no row for the position. */
  | 'unlocated'
  /** The row resolved but is not mounted, so it cannot be scrolled to. */
  | 'unmounted'

/**
 * Whether one Chat row presents the content of an event position.
 *
 * A compaction row presents two events: the checkpoint `user/message` it landed
 * (`seq`) and the `compaction/summary` it cites (`summaryEventSeq`). Searching
 * either must reach that card, because the card is where the text is shown.
 * @param node - visible Chat row.
 * @param seq - durable event position a search hit names.
 * @returns whether this row presents that position.
 */
function ownsSeq(node: ChatNode, seq: number): boolean {
  if (node.kind === 'compaction') return node.data.seq === seq || node.data.summaryEventSeq === seq
  return messageSeqOf(node) === seq
}

/** The Chat row one message position resolves to, and the process fold hiding it. */
export interface ChatRevealTarget {
  /** Stable Conversation Context key of the row that renders the message. */
  readonly key: string
  /**
   * Turn-process disclosure this row sits inside, or null when it is not
   * folded; opening it is the reader's own choice for that Turn.
   */
  readonly process: { readonly turn: number; readonly answerStep: number } | null
}

/**
 * The durable message position a row renders directly, when the row carries one.
 * @param node - projected Chat node.
 * @returns the row's own message seq, or undefined when it owns none.
 */
function messageSeqOf(node: ChatNode): number | undefined {
  switch (node.kind) {
    case 'user':
    case 'steering':
    case 'context':
      return node.data.seq
    case 'assistant-step':
      // The settlement event, not the row's first-chunk `anchorSeq`.
      return node.data.finalNode?.seq
    case 'turn-tail':
      return node.data.seq
    case 'manual-compaction':
      return node.data.command.seq
    case 'compaction':
      return node.data.seq
    // Merge-extensible kind space: a kind that owns no durable message
    // identity cannot be reached from a search hit.
    default:
      return undefined
  }
}

/**
 * Resolve a durable message position to the visible Chat row that renders it.
 *
 * Only a row that presents this event resolves: sequence proximity and Turn
 * membership do not establish a match, and a neighbouring row is not the
 * message the reader asked for. Callers page history first, then treat a
 * refusal as a position this view cannot show.
 * @param snapshot - live Chat target snapshot.
 * @param seq - durable event position a search hit names.
 * @returns the row to land on, or undefined when the loaded window cannot place the position.
 */
export function resolveChatRevealTarget(snapshot: ChatSnapshot, seq: number): ChatRevealTarget | undefined {
  const rows: ChatNode[] = []
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key)
    if (node !== undefined && isVisibleChatNode(node as ChatNode)) rows.push(node as ChatNode)
  }
  // Identity only: an anchor or a Turn's neighbourhood is not evidence that
  // a row presents this event, and landing elsewhere is worse than reporting
  // that the loaded window cannot show it.
  const node = rows.find(row => ownsSeq(row, seq))
  if (node === undefined) return undefined
  const presentation = snapshot.nodes.processSource(node.key).getSnapshot()
  return {
    key: node.key,
    process: presentation === undefined
      ? null
      : { turn: presentation.spec.turn, answerStep: presentation.spec.answerStep ?? 0 },
  }
}
