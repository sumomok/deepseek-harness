/** Landing resolution: one durable message position must name the row that renders it. */
import { describe, expect, it } from 'vitest'
import type {
  ConversationTimelineSnapshot, StepLocation, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'
import { resolveChatRevealTarget } from '../src/client/contract/reveal.ts'
import { EMPTY_CHAT_SNAPSHOT, type ChatSnapshot, type ChatTurnProcessPresentation } from '../src/client/contract/snapshot.ts'
import type { TurnProcessSpec } from '../src/client/contract/turn-process.ts'

/** Location data neither case reads; the interface is required by every Turn. */
const LOCATION_DATA: TurnLocation['data'] = {
  get: () => undefined,
  source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
}

function step(turn: number, number: number, start: number, end: number): StepLocation {
  return {
    turn,
    step: number,
    start: { type: 'step/start', seq: SessionSeq(start), time: start, data: { turn, step: number } },
    end: { type: 'step/end', seq: SessionSeq(end), time: end, data: { turn, step: number } },
    status: 'closed',
    data: LOCATION_DATA,
  }
}

function turn(number: number, start: number, end: number, steps: readonly StepLocation[]): TurnLocation {
  return {
    turn: number,
    start: { type: 'turn/start', seq: SessionSeq(start), time: start, data: { turn: number } },
    end: {
      type: 'turn/end',
      seq: SessionSeq(end),
      time: end,
      data: { turn: number, reason: { kind: 'completed' } },
    },
    status: 'closed',
    steps,
    data: LOCATION_DATA,
  }
}

function userRow(seq: number, owner: TurnLocation): ChatConversationViewNode {
  return {
    key: `user:${String(seq)}`,
    id: String(seq),
    kind: 'user',
    target: 'chat',
    anchorSeq: seq,
    location: { kind: 'turn', turn: owner },
    visibility: 'visible',
    data: { kind: 'user', seq, time: seq, content: [{ type: 'text', text: 'question' }], source: null },
  }
}

/**
 * One Assistant row whose render position is its first visible chunk (`anchorSeq`)
 * while the message the search index reports is the later settlement event.
 */
function assistantRow(input: {
  readonly anchorSeq: number
  readonly messageSeq: number
  readonly owner: TurnLocation
  readonly number: number
}): ChatConversationViewNode {
  return {
    key: `assistant:${String(input.messageSeq)}`,
    id: String(input.messageSeq),
    kind: 'assistant-step',
    target: 'chat',
    anchorSeq: input.anchorSeq,
    location: { kind: 'step', turn: input.owner, step: input.owner.steps[0] as StepLocation },
    visibility: 'visible',
    data: {
      status: 'settled',
      turn: input.owner.turn,
      step: input.number,
      blocks: [{ kind: 'text', text: 'answer' }],
      time: input.messageSeq,
      finalNode: {
        kind: 'assistant',
        seq: input.messageSeq,
        time: input.messageSeq,
        turn: input.owner.turn,
        step: input.number,
        blocks: [{ kind: 'text', text: 'answer' }],
      },
    },
  }
}

function presentation(owner: TurnLocation, answerStep: number): ChatTurnProcessPresentation {
  const spec: TurnProcessSpec = {
    turn: owner.turn,
    controlAnchorSeq: owner.steps[0]?.start?.seq ?? 0,
    processStartSeq: owner.steps[0]?.start?.seq ?? 0,
    answerAnchorSeq: null,
    answerStep,
    inlineReasoning: false,
    messageCount: 0,
    toolCallCount: 1,
    subagentCount: 0,
  }
  return {
    turn: owner.turn,
    spec,
    turnStarted: true,
    turnClosed: true,
    hasExternalProcess: true,
    hasNonReplyProcess: true,
    hasInterleavedInput: false,
  }
}

function snapshotOf(input: {
  readonly rows: readonly ChatConversationViewNode[]
  readonly turns: readonly TurnLocation[]
  readonly folded?: ChatConversationViewNode
  readonly foldedProcessStep?: number
}): ChatSnapshot {
  const turns = new Map(input.turns.map(value => [value.turn, value]))
  const timeline: ConversationTimelineSnapshot = {
    turnOrder: input.turns.map(value => value.turn),
    turns,
  }
  const presentations = input.folded === undefined
    ? new Map<string, ChatTurnProcessPresentation>()
    : new Map([[input.folded.key, presentation(input.turns[0] as TurnLocation, input.foldedProcessStep ?? 1)]])
  const byKey = new Map(input.rows.map(row => [row.key, row]))
  return {
    ...EMPTY_CHAT_SNAPSHOT,
    order: input.rows.map(row => row.key),
    nodes: {
      ...EMPTY_CHAT_SNAPSHOT.nodes,
      get: key => byKey.get(key),
      values: () => input.rows,
      processSource: key => ({
        getSnapshot: () => presentations.get(key),
        subscribe: () => () => {},
      }),
    },
    locations: {
      getTurn: turn => input.rows
        .filter((row) => {
          const location = row.location
          return (location.kind === 'turn' || location.kind === 'step') && location.turn.turn === turn
        })
        .map(row => row.key),
      getStep: (turn, number) => input.rows
        .filter((row) => {
          const location = row.location
          return location.kind === 'step' && location.turn.turn === turn && location.step.step === number
        })
        .map(row => row.key),
    },
    timeline,
  }
}

describe('resolveChatRevealTarget', () => {
  const answering = turn(1, 10, 40, [step(1, 1, 12, 39)])

  it('lands on the Assistant row even though its anchorSeq precedes the searched message', () => {
    const question = userRow(11, answering)
    const answer = assistantRow({ anchorSeq: 20, messageSeq: 30, owner: answering, number: 1 })
    const snapshot = snapshotOf({ rows: [question, answer], turns: [answering] })

    // The search index reports the settled `assistant/message` seq, not the
    // row's first-chunk anchor: equality against `anchorSeq` would miss the row.
    expect(resolveChatRevealTarget(snapshot, 30)?.key).toBe(answer.key)
    expect(resolveChatRevealTarget(snapshot, 20)?.key).toBe(answer.key)
  })

  it('lands on the user row that owns the searched message', () => {
    const question = userRow(11, answering)
    const answer = assistantRow({ anchorSeq: 20, messageSeq: 30, owner: answering, number: 1 })
    const snapshot = snapshotOf({ rows: [question, answer], turns: [answering] })

    expect(resolveChatRevealTarget(snapshot, 11)?.key).toBe(question.key)
  })

  it('places a hit on an event with no row of its own at the row its Step had opened', () => {
    const question = userRow(11, answering)
    const answer = assistantRow({ anchorSeq: 20, messageSeq: 30, owner: answering, number: 1 })
    const snapshot = snapshotOf({ rows: [question, answer], turns: [answering] })

    // A `tool/result` between the two rows: no row renders it, and the Step
    // interval says the Assistant row is what the reader was looking at.
    expect(resolveChatRevealTarget(snapshot, 25)?.key).toBe(answer.key)
  })

  it('lands on the compaction row for both its checkpoint and its cited summary', () => {
    const owner = turn(1, 10, 40, [step(1, 1, 12, 39)])
    const card: ChatConversationViewNode = {
      key: 'compaction:30',
      id: '30',
      kind: 'compaction',
      target: 'chat',
      anchorSeq: 30,
      location: { kind: 'turn', turn: owner },
      visibility: 'visible',
      data: {
        kind: 'compaction', seq: 30, time: 30, summary: 'summary text',
        summaryEventSeq: 29, shadowedItemCount: 4, shadowedTokenCount: 120,
      },
    }
    const snapshot = snapshotOf({ rows: [card], turns: [owner] })

    // The card presents the checkpoint message it landed (`seq`) and the
    // summary it cites (`summaryEventSeq`); a hit on either belongs here.
    expect(resolveChatRevealTarget(snapshot, 30)?.key).toBe(card.key)
    expect(resolveChatRevealTarget(snapshot, 29)?.key).toBe(card.key)
  })

  it('reports the Turn-process fold that hides the row it lands on', () => {
    const answer = assistantRow({ anchorSeq: 20, messageSeq: 30, owner: answering, number: 1 })
    const snapshot = snapshotOf({ rows: [answer], turns: [answering], folded: answer, foldedProcessStep: 1 })

    expect(resolveChatRevealTarget(snapshot, 30)?.process).toEqual({ turn: 1, answerStep: 1 })
  })

  it('reports no fold for a row outside any Turn process', () => {
    const question = userRow(11, answering)
    const snapshot = snapshotOf({ rows: [question], turns: [answering] })

    expect(resolveChatRevealTarget(snapshot, 11)?.process).toBeNull()
  })

  it('refuses a position the loaded window cannot place', () => {
    const question = userRow(11, answering)
    // The window starts after the hit's Turn: nothing places seq 5.
    const later = turn(2, 50, 80, [step(2, 1, 52, 79)])
    const snapshot = snapshotOf({ rows: [question], turns: [answering, later] })

    expect(resolveChatRevealTarget(snapshot, 5)).toBeUndefined()
    expect(resolveChatRevealTarget(snapshot, 90)).toBeUndefined()
  })

  it('never lands on a hidden row, even when that row carries the position', () => {
    const question = { ...userRow(11, answering), visibility: 'hidden' as const }
    const answer = assistantRow({ anchorSeq: 20, messageSeq: 30, owner: answering, number: 1 })
    const snapshot = snapshotOf({ rows: [question, answer], turns: [answering] })

    // A settled Assistant with no visible content keeps its row as `hidden`;
    // the nearest visible row of the same Turn is the honest landing.
    expect(resolveChatRevealTarget(snapshot, 11)?.key).toBe(answer.key)
  })
})
