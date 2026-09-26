/**
 * Sessions this fork's shipped builds wrote at format 0 reopen through the
 * whole installed catalog: every named out-of-repo event type arrives as an
 * ignorable `plugin:<type>` event, an `at-file-mention` message source survives
 * unchanged, and a `command/run` keeps its `engages` declaration.
 */
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createSessionFormatCatalogWithChildren } from '../src/index.ts'

const FORK_EVENT_TYPES = [
  'attachment/materialized',
  'content-component/resolved',
  'content-component/shown',
  'content-surface/dismissed',
  'content-surface/selected',
  'content/navigated',
  'content/shown',
  'permissionRules/decision',
] as const

describe('fork-written v0 Sessions through the installed catalog', () => {
  it('carries named out-of-repo events, a file-mention source, and an engages declaration to the current format', () => {
    const header = { type: 'session', version: 0, id: 'fork-history', createdAt: 1, seedLength: 0, delegationDepth: 0 }
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      {
        type: 'user/message', seq: 2, time: 2, surfaceOp: 'append',
        data: {
          id: 'user-mention', role: 'user',
          content: [{ type: 'text', text: '<workspace-reference path="test/1.txt" kind="file" />' }],
          source: { kind: 'at-file-mention', relative: 'test/1.txt' },
        },
      },
      ...FORK_EVENT_TYPES.map((type, index) => ({
        type, seq: 3 + index, time: 3, data: { marker: type }, ignorable: true,
      })),
      {
        type: 'command/run', seq: 3 + FORK_EVENT_TYPES.length, time: 4,
        data: { commandId: 'cmd-perm', name: 'permission', source: { kind: 'user' }, engages: false },
      },
    ]

    const restore = createSessionFormatCatalogWithChildren([]).createRestore(header, {
      recovery: 'strict', validation: 'current',
    })
    for (const row of rows) restore.decodeRow(row)
    const artifact = restore.finish()

    expect(artifact.header.version).toBe(SESSION_FORMAT_VERSION)
    for (const type of FORK_EVENT_TYPES) {
      expect(artifact.events.find(event => event.type === `plugin:${type}`))
        .toMatchObject({ data: { marker: type }, ignorable: true })
    }
    expect(artifact.events.filter(event => FORK_EVENT_TYPES.some(type => event.type === type))).toEqual([])
    expect(artifact.events.find(event => event.type === 'user/message'))
      .toMatchObject({ data: { source: { kind: 'at-file-mention', relative: 'test/1.txt' } } })
    expect(artifact.events.find(event => event.type === 'command/run'))
      .toMatchObject({ data: { commandId: 'cmd-perm', engages: false } })
  })
})
