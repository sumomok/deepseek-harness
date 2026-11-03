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
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from './chat-nodes.ts'
import { isVisibleChatNode } from './chat-visibility.ts'
import type { ChatSnapshot } from './snapshot.ts'

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
    // Merge-extensible kind space: a kind without a durable message identity
    // is resolved by its Location interval below.
    default:
      return undefined
  }
}

/**
 * Whether one Turn/Step boundary pair admits a seq.
 * @param start - boundary seq, absent when the window starts inside the range.
 * @param end - closing seq, absent while the range is still open.
 * @param seq - message position to place.
 * @returns whether the range admits the position.
 */
function admits(start: number | undefined, end: number | undefined, seq: number): boolean {
  if (end !== undefined && seq > end) return false
  if (start !== undefined && seq < start) return false
  return true
}

/**
 * Find the loaded Turn whose boundaries admit a seq.
 * @param snapshot - current Chat target snapshot.
 * @param seq - message position to place.
 * @returns the owning Turn, or undefined when the loaded window cannot place it.
 */
function turnAt(snapshot: ChatSnapshot, seq: number): TurnLocation | undefined {
  for (const turn of snapshot.timeline.turnOrder) {
    const location = snapshot.timeline.turns.get(turn)
    if (location !== undefined && admits(location.start?.seq, location.end?.seq, seq)) return location
  }
  return undefined
}

/**
 * Resolve a durable message position to the visible Chat row that renders it.
 *
 * The window must already cover `seq`; callers page history through the
 * Session's jump loader first. A position no row renders still resolves to
 * the row its Turn/Step had open at that point, so a hit on an event without a
 * row of its own lands in the right place instead of falling back silently.
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
  const byKey = new Map(rows.map(row => [row.key, row]))
  const direct = rows.find(row => messageSeqOf(row) === seq)
  const node = direct ?? rows.find(row => row.anchorSeq === seq) ?? intervalRow(snapshot, byKey, seq)
  if (node === undefined) return undefined
  const presentation = snapshot.nodes.processSource(node.key).getSnapshot()
  return {
    key: node.key,
    process: presentation === undefined
      ? null
      : { turn: presentation.spec.turn, answerStep: presentation.spec.answerStep ?? 0 },
  }
}

/**
 * Place a seq inside its Step (or Turn) and take the last row that had opened there.
 * @param snapshot - current Chat target snapshot.
 * @param rows - visible rows by key.
 * @param seq - message position to place.
 * @returns the row to land on, or undefined when the Turn is not loaded.
 */
function intervalRow(
  snapshot: ChatSnapshot,
  rows: ReadonlyMap<string, ChatNode>,
  seq: number,
): ChatNode | undefined {
  const turn = turnAt(snapshot, seq)
  if (turn === undefined) return undefined
  const step = turn.steps.find(candidate => admits(candidate.start?.seq, candidate.end?.seq, seq))
  const keys = step === undefined
    ? snapshot.locations.getTurn(turn.turn)
    : snapshot.locations.getStep(turn.turn, step.step)
  let landed: ChatNode | undefined
  let first: ChatNode | undefined
  for (const key of keys) {
    const node = rows.get(key)
    if (node === undefined) continue
    first ??= node
    // A Turn-process control is a disclosure header, not a message: prefer any
    // row that actually carries content around the position.
    if (node.anchorSeq <= seq && node.kind !== 'turn-process') landed = node
  }
  return landed ?? first
}
