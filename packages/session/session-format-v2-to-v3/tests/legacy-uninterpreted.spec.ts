import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { restoreReleasedV3Artifact, sessionFormatV2ToV3 } from '../src/index.ts'

const header = { version: 2, id: 'uninterpreted', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const opening: readonly SessionFormatEvent[] = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
]

function migrate(input: readonly SessionFormatEvent[]) {
  const targetHeader = sessionFormatV2ToV3.migrateHeader(header)
  const stage = sessionFormatV2ToV3.createStage({
    sourceHeader: header,
    targetHeader,
    sourceInheritedEventCount: 0,
    sourceKind: 'decoded',
  })
  const collector = new SessionFormatEventCollector()
  for (const [seq, value] of input.entries()) stage.transformEvent({ ...value, seq }, collector)
  return { header: targetHeader, inheritedEventCount: stage.finish(collector), events: collector.values }
}

describe('named uninterpreted historical events at the v2-to-v3 edge', () => {
  it('carries a named type verbatim with its ignorable envelope', () => {
    const carried: readonly SessionFormatEvent[] = [
      { type: 'attachment/materialized', seq: 0, time: 1, data: { attachmentId: 'a', locator: 'spill:1' }, ignorable: true },
      { type: 'permissionRules/decision', seq: 1, time: 2, data: { toolName: 'read', outcome: 'deny' }, ignorable: true },
    ]

    const migrated = migrate(carried)

    expect(migrated.events).toEqual(carried)
    expect(() => restoreReleasedV3Artifact(migrated, new Set())).not.toThrow()
  })

  it('carries a named historical message source kind and refuses one nobody named', () => {
    const message = {
      id: 'user-mention', role: 'user',
      content: [{ type: 'text', text: '<workspace-reference path="test/1.txt" kind="file" />' }],
      source: { kind: 'at-file-mention', relative: 'test/1.txt' },
    }
    const mention = {
      type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: message,
    } as unknown as SessionFormatEvent

    const migrated = migrate([...opening, mention])

    const carried = migrated.events.find(one => one.type === 'user/message')
    expect((carried?.data as { source: unknown }).source).toEqual({ kind: 'at-file-mention', relative: 'test/1.txt' })
    expect(() => restoreReleasedV3Artifact(migrated, new Set())).not.toThrow()
    expect(() => migrate([...opening, {
      ...mention,
      data: { ...message, source: { kind: 'other-plugin' } },
    }])).toThrow(/cannot safely transform unclassified message source/)
  })

  it('still refuses a v2 event type nobody named', () => {
    expect(() => migrate([
      { type: 'thirdParty/other', seq: 0, time: 1, data: {}, ignorable: true },
    ])).toThrow(/cannot safely transform unclassified event thirdParty\/other/)
  })
})
