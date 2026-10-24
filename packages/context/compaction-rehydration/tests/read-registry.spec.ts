/**
 * The replayable read registry and its freshness decisions: what the log says
 * about each read, and when a recorded read still counts as current.
 */

import { describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { classifyRead, readRegistry, readWindowDigest } from '../src/read-registry.ts'
import type { ReadFsLike } from '../src/read-registry.ts'

const APPEND = { surfaceOp: 'append' as const }

interface FakeFile {
  text: string
  version: string
  size?: number
  type?: string
}

class FakeReadFs implements ReadFsLike {
  readonly files = new Map<string, FakeFile>()
  statCalls = 0
  readCalls = 0

  add(path: string, file: FakeFile): void {
    this.files.set(path, file)
  }

  async resolve(path: string): Promise<object> {
    return { key: path }
  }

  async stat(target: object): Promise<{ version: string; size?: number; type: string } | undefined> {
    this.statCalls += 1
    const file = this.files.get(keyOf(target))
    if (file === undefined) return undefined
    return {
      version: file.version,
      type: file.type ?? 'file',
      ...file.size === undefined ? {} : { size: file.size },
    }
  }

  async readText(target: object): Promise<string> {
    this.readCalls += 1
    const file = this.files.get(keyOf(target))
    if (file === undefined) throw new Error('missing')
    return file.text
  }
}

function keyOf(target: object): string {
  return (target as { key?: string }).key ?? ''
}

/** One Session with a user turn and one successful `read` call. */
function bench(): Session {
  const session = Session.create(SessionId('read-registry'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'go' }],
    source: { kind: 'user' },
  }), APPEND)
  return session
}

/** Record one read result the way the read tool does: call, then result with meta. */
function recordRead(
  session: Session,
  callId: string,
  path: string,
  meta: Record<string, unknown>,
  options: { isError?: boolean } = {},
): void {
  const call = ToolCallId(callId)
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: call,
    name: 'read',
    arguments: JSON.stringify({ file_path: path }),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: call,
      content: [{ type: 'text', text: 'read result' }],
      isError: options.isError === true,
    }),
    ...options.isError === true ? {} : { meta },
  }, APPEND)
}

function fullMeta(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const lines = text.split('\n').map((line, index) => ({ number: index + 1, text: line }))
  return {
    path: '/abs/a.txt',
    offset: 1,
    lines,
    totalLines: lines.length,
    version: 'v1',
    size: Buffer.byteLength(text, 'utf8'),
    read: 'full',
    digest: readWindowDigest(lines),
    ...overrides,
  }
}

describe('the read registry a Session log can replay', () => {
  it('folds a successful read with its version, coverage, and digest', () => {
    const session = bench()
    recordRead(session, 'c1', '/abs/a.txt', fullMeta('one\ntwo'))
    const registry = readRegistry(session)
    expect(registry.records).toHaveLength(1)
    expect(registry.records[0]).toMatchObject({
      path: '/abs/a.txt',
      offset: 1,
      totalLines: 2,
      version: 'v1',
      read: 'full',
      size: 7,
    })
    expect(registry.records[0]?.digest).toBe(readWindowDigest([{ text: 'one' }, { text: 'two' }]))
    expect(registry.records[0]?.readSeq).toBe(2)
    expect(registry.records[0]?.callSeq).toBe(1)
  })

  it('keeps the newest successful read per path and does not duplicate it', () => {
    const session = bench()
    recordRead(session, 'c1', '/abs/a.txt', fullMeta('first'))
    recordRead(session, 'c2', '/abs/a.txt', fullMeta('second'))
    const records = readRegistry(session).records
    expect(records).toHaveLength(1)
    expect(records[0]?.lines[0]?.text).toBe('second')
  })

  it('records a failed read without erasing the earlier success', () => {
    const session = bench()
    recordRead(session, 'c1', '/abs/a.txt', fullMeta('kept'))
    recordRead(session, 'c2', '/abs/a.txt', {}, { isError: true })
    const registry = readRegistry(session)
    expect(registry.records).toHaveLength(1)
    expect(registry.failures).toEqual([{ path: '/abs/a.txt', callSeq: 3 }])
  })

  it('follows a pruned replacement back to the original result sequence', () => {
    const session = bench()
    recordRead(session, 'c1', '/abs/a.txt', fullMeta('one'))
    const original = session.snapshotEvents().findLast(event => event.type === 'tool/result')!
    if (original.type !== 'tool/result') throw new Error('no original result')
    const replacement = session.append('tool/result', {
      turn: original.data.turn,
      step: original.data.step,
      message: {
        ...original.data.message,
        content: [{ type: 'text', text: '[... tool result middle pruned ...]' }],
      },
      ...original.data.meta === undefined ? {} : { meta: original.data.meta },
    }, {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
      sourceEventSeqs: [original.seq],
    })
    const record = readRegistry(session).records[0]!
    expect(record.readSeq).toBe(original.seq)
    expect(record.readSeq).not.toBe(replacement.seq)
  })

  it('ignores non-read calls and malformed metadata', () => {
    const session = bench()
    session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('bash-1'), name: 'bash', arguments: '{"command":"ls"}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('bash-1'),
        content: [{ type: 'text', text: 'a.txt' }],
        isError: false,
      }),
      meta: { path: '/abs/a.txt' },
    }, APPEND)
    recordRead(session, 'c1', '/abs/b.txt', { path: '/abs/b.txt', offset: 0, lines: [], totalLines: 0 })
    expect(readRegistry(session).records).toHaveLength(0)
  })

  it('returns no records for a session that never read a file', () => {
    expect(readRegistry(bench())).toEqual({ records: [], failures: [] })
  })
})

describe('classifying a recorded read against the current file', () => {
  it('accepts a full read whose recorded version still matches without reading content', async () => {
    const session = bench()
    recordRead(session, 'c1', '/abs/a.txt', fullMeta('one\ntwo'))
    const fs = new FakeReadFs()
    fs.add('/abs/a.txt', { text: 'one\ntwo', version: 'v1' })
    const record = readRegistry(session).records[0]!
    const result = await classifyRead(record, fs)
    expect(result.kind).toBe('already_read_file')
    expect(fs.readCalls).toBe(0)
  })

  it('returns current content for a full read whose version changed', async () => {
    const session = bench()
    recordRead(session, 'c1', '/abs/a.txt', fullMeta('old'))
    const fs = new FakeReadFs()
    fs.add('/abs/a.txt', { text: 'new', version: 'v2' })
    const result = await classifyRead(readRegistry(session).records[0]!, fs)
    expect(result).toMatchObject({ kind: 'file', text: 'new' })
  })

  it('never restores a recorded window as a full read', async () => {
    const session = bench()
    recordRead(session, 'c1', '/abs/a.txt', fullMeta('one\ntwo', { offset: 2, read: 'window', totalLines: 2 }))
    const fs = new FakeReadFs()
    fs.add('/abs/a.txt', { text: 'one\ntwo', version: 'v1' })
    const result = await classifyRead(readRegistry(session).records[0]!, fs)
    expect(result).toMatchObject({ kind: 'compact_file_reference', reason: 'partial-window' })
  })

  it('verifies an older log by digest before trusting it', async () => {
    const legacy = fullMeta('one\ntwo')
    delete legacy['version']
    delete legacy['read']
    delete legacy['size']
    const session = bench()
    recordRead(session, 'c1', '/abs/a.txt', legacy)
    const fs = new FakeReadFs()
    fs.add('/abs/a.txt', { text: 'one\ntwo\n', version: 'v1' })
    expect((await classifyRead(readRegistry(session).records[0]!, fs)).kind).toBe('already_read_file')

    const changed = new FakeReadFs()
    changed.add('/abs/a.txt', { text: 'one\nthree', version: 'v1' })
    expect(await classifyRead(readRegistry(session).records[0]!, changed)).toMatchObject({ kind: 'file', text: 'one\nthree' })
  })

  it('treats an older log with a short window as a partial read', async () => {
    const legacy = fullMeta('one\ntwo', { offset: 2, totalLines: 2 })
    delete legacy['version']
    delete legacy['read']
    const session = bench()
    recordRead(session, 'c1', '/abs/a.txt', legacy)
    const fs = new FakeReadFs()
    fs.add('/abs/a.txt', { text: 'one\ntwo', version: 'v1' })
    expect(await classifyRead(readRegistry(session).records[0]!, fs)).toMatchObject({
      kind: 'compact_file_reference',
      reason: 'partial-window',
    })
  })

  it('reports missing, non-file, unreadable, oversized, and absent-service cases', async () => {
    const session = bench()
    recordRead(session, 'c1', '/abs/a.txt', fullMeta('one'))
    const record = readRegistry(session).records[0]!

    expect(await classifyRead(record, new FakeReadFs())).toMatchObject({ kind: 'compact_file_reference', reason: 'missing' })

    const directory = new FakeReadFs()
    directory.add('/abs/a.txt', { text: 'one', version: 'v1', type: 'directory' })
    expect(await classifyRead(record, directory)).toMatchObject({ kind: 'compact_file_reference', reason: 'not-file' })

    const unreadable = new FakeReadFs()
    unreadable.add('/abs/a.txt', { text: 'one', version: 'v2' })
    unreadable.readText = async () => { throw new Error('denied') }
    expect(await classifyRead(record, unreadable)).toMatchObject({ kind: 'compact_file_reference', reason: 'unreadable' })

    const oversized = new FakeReadFs()
    oversized.add('/abs/a.txt', { text: 'one', version: 'v2', size: 10_000 })
    expect(await classifyRead(record, oversized, { maxInspectBytes: 1_000 })).toMatchObject({
      kind: 'compact_file_reference',
      reason: 'oversized',
    })

    expect(await classifyRead(record, undefined)).toMatchObject({ kind: 'compact_file_reference', reason: 'unavailable' })
  })
})
