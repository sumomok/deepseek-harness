import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Microcompact, resolveConfig } from '../src/index.ts'
import type { MicrocompactConfig } from '../src/index.ts'

const MODEL = 'test-model'

interface StepResult {
  readonly name?: string
  readonly text?: string
  readonly blocks?: readonly ContentBlock[]
  readonly isError?: boolean
}

function context(config: MicrocompactConfig): { readonly compact: Microcompact; readonly ctx: Context } {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  return { compact: new Microcompact(ctx, config), ctx }
}

function appendToolStep(session: Session, turn: number, results: readonly StepResult[]): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${String(turn)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  for (const [index, result] of results.entries()) {
    const callId = ToolCallId(`call-${String(turn)}-${String(index)}`)
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: result.name ?? 'bash', arguments: '{}' }],
        source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: result.name ?? 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: result.blocks ?? [{ type: 'text', text: result.text ?? 'result '.repeat(100) }],
        isError: result.isError ?? false,
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function busySession(count = 25): Session {
  vi.setSystemTime(1_000)
  const session = Session.create(SessionId('microcompact'))
  appendToolStep(session, 1, [])
  // Gap is measured from the previous turn's last durable event.
  vi.setSystemTime(1_000 + 3_900_000)
  appendToolStep(session, 2, Array.from({ length: count }, () => ({ text: 'old result '.repeat(200) })))
  return session
}

const BASE: MicrocompactConfig = {
  enabled: true,
  minIdleSeconds: 0,
  keepRecentToolUses: 5,
  minClearableToolUses: 20,
  clearAtLeastTokens: 10,
  maxClearPerRun: 50,
  keepErrors: true,
  allowHostOnlyReadback: true,
}

describe('idle microcompact configuration', () => {
  it('resolves safe defaults and rejects bad values', () => {
    expect(resolveConfig()).toEqual({
      enabled: false,
      minIdleSeconds: 3900,
      keepRecentToolUses: 5,
      minClearableToolUses: 20,
      clearAtLeastTokens: 20_000,
      maxClearPerRun: 50,
      keepErrors: true,
      allowHostOnlyReadback: false,
      excludeTools: [],
    })
    expect(() => resolveConfig({ minIdleSeconds: -1 })).toThrow(/non-negative/)
    expect(() => resolveConfig({ unknown: true } as MicrocompactConfig)).toThrow(/unknown key/)
  })
})

describe('idle microcompact preview and apply', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('requires durable idle time', async () => {
    vi.setSystemTime(1_000)
    const session = Session.create(SessionId('no-idle'))
    appendToolStep(session, 1, [{ text: 'previous' }])
    vi.setSystemTime(1_000 + 10)
    appendToolStep(session, 2, Array.from({ length: 25 }, () => ({ text: 'result '.repeat(200) })))
    const { compact } = context({ ...BASE, minIdleSeconds: 60 })
    const preview = await compact.preview(session)
    expect(preview.entries).toHaveLength(0)
    expect(preview.skipped).toEqual([{ reason: 'not-idle' }])
  })

  it('clears exactly the old results after keep-recent and count thresholds', async () => {
    const session = busySession(25)
    const { compact } = context(BASE)
    const preview = await compact.preview(session)
    expect(preview.entries).toHaveLength(20)
    expect(preview.reclaimableTokens).toBeGreaterThan(0)

    const result = compact.apply(session, preview)
    expect(result.cleared).toHaveLength(20)
    expect(result.skipped).toBe(0)
    const markers = session.snapshotEvents().filter(event => event.type === 'compaction/prune')
    expect(markers).toHaveLength(20)
    for (const entry of preview.entries) {
      const text = entry.replacement.content.map(block => block.type === 'text' ? block.text : '').join('')
      expect(text).toContain(`seq ${String(entry.addressSeq)}`)
      expect(text).toContain('untrusted data')
    }
    expect(preview.entries[0]!.originalSeq).toBeLessThan(preview.entries.at(-1)!.originalSeq)

    const second = compact.apply(session, preview)
    expect(second.cleared).toHaveLength(0)
    expect(second.skipped).toBe(20)
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/prune')).toHaveLength(20)
  })

  it('counts net estimated savings, not the original token total', async () => {
    const session = busySession(25)
    const probe = await context({ ...BASE, clearAtLeastTokens: 0 }).compact.preview(session)
    const net = probe.entries.reduce((total, entry) => total + entry.savings, 0)
    expect(net).toBeGreaterThan(0)
    const exact = await context({ ...BASE, clearAtLeastTokens: net }).compact.preview(session)
    expect(exact.entries).toHaveLength(20)
    const above = await context({ ...BASE, clearAtLeastTokens: net + 1 }).compact.preview(session)
    expect(above.entries).toHaveLength(0)
    expect(above.skipped).toEqual([{ reason: 'below-tokens' }])
  })

  it('keeps the newest N unique tool uses even when one call has multiple results', async () => {
    vi.setSystemTime(1_000)
    const session = Session.create(SessionId('unique-calls'))
    appendToolStep(session, 1, [])
    vi.setSystemTime(1_000 + 3_900_000)
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 2, step: 1 })
    const add = (call: string, count: number): void => {
      const callId = ToolCallId(call)
      session.append('assistant/message', {
        stream: [], turn: 2, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
          source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: 2, step: 1, callId, name: 'bash', arguments: '{}' })
      for (let index = 0; index < count; index += 1) {
        session.append('tool/result', {
          turn: 2,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: `${call} result ${String(index)} `.repeat(100) }],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
      }
    }
    add('old', 2)
    add('middle', 1)
    add('newest', 1)
    const { compact } = context({ ...BASE, keepRecentToolUses: 3, minClearableToolUses: 1 })
    const preview = await compact.preview(session)
    expect(preview.entries).toHaveLength(0)
    expect(preview.skipped).toEqual([{ reason: 'below-count' }])
  })

  it('checks the readback tool in the agent scope', async () => {
    const session = busySession(25)
    const { compact, ctx } = context({ ...BASE, allowHostOnlyReadback: false })
    const restricted = { session, options: {} } as Agent
    const unrestricted = { session, options: {} } as Agent
    ctx.provide('tools', {
      get: (_name: string, scope?: Agent) => scope === restricted ? undefined : { name: 'session_event_read' },
    })
    expect((await compact.preview(session, restricted)).skipped).toEqual([{ reason: 'no-readback' }])
    expect((await compact.preview(session, unrestricted)).entries).toHaveLength(20)
  })

  it('does not heal a marker while an active job is unresolved', async () => {
    const session = busySession(25)
    const target = session.surface.nodes.at(-1)!
    const event = session.eventAt(target)
    if (event?.type !== 'tool/result') throw new Error('expected a tool result')
    session.append('compaction/prune', {
      shadowedRange: { start: target, end: target },
      shadowedSeqs: [target],
      shadowedTokenCount: 1,
    })
    session.append('job/registered', {
      jobId: 'job-active' as never,
      owner: session.header.id,
      kind: 'bash',
      label: 'active',
      startedAt: 1_000,
    })
    const { compact } = context(BASE)
    const before = session.surface.nodes.length
    await compact.runIdle({ session, options: {} } as Agent)
    expect(session.surface.nodes).toHaveLength(before)
    expect(session.snapshotEvents().at(-1)?.type).toBe('job/registered')
  })

  it('marks an idle window attempted even when preview throws', async () => {
    const session = busySession(25)
    const { compact } = context(BASE)
    const preview = vi.spyOn(compact, 'preview').mockRejectedValue(new Error('preview failed'))
    await expect(compact.runIdle({ session, options: {} } as Agent)).rejects.toThrow('preview failed')
    await compact.runIdle({ session, options: {} } as Agent)
    expect(preview).toHaveBeenCalledTimes(1)
  })

  it('refuses below the post-exclusion count and below the token threshold', async () => {
    const { compact } = context(BASE)
    const short = busySession(24)
    expect((await compact.preview(short)).skipped).toEqual([{ reason: 'below-count' }])

    const expensive = busySession(25)
    const { compact: high } = context({ ...BASE, clearAtLeastTokens: 1_000_000 })
    expect((await high.preview(expensive)).skipped).toEqual([{ reason: 'below-tokens' }])
  })

  it('does not run without a model readback tool unless host-only is explicit', async () => {
    const session = busySession(25)
    const { compact } = context({ ...BASE, allowHostOnlyReadback: false })
    expect((await compact.preview(session)).skipped).toEqual([{ reason: 'no-readback' }])
  })

  it('skips non-text, errored, excluded, and unpaired results', async () => {
    vi.setSystemTime(1_000)
    const session = Session.create(SessionId('filters'))
    appendToolStep(session, 1, [{ text: 'previous' }])
    vi.setSystemTime(1_000 + 3_900_000)
    appendToolStep(session, 2, [
      { text: 'plain '.repeat(200) },
      { blocks: [{ type: 'image', attachment: {
        attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      } }] },
      { text: 'error '.repeat(200), isError: true },
      { text: 'excluded '.repeat(200), name: 'skip-me' },
    ])
    const { compact } = context({ ...BASE, minClearableToolUses: 1, excludeTools: ['skip-me'], keepErrors: true })
    const preview = await compact.preview(session)
    expect(preview.entries).toHaveLength(0)
    expect(preview.skipped).toEqual([{ reason: 'below-count' }])
  })

  it('ignores a tool result with no paired tool call', async () => {
    vi.setSystemTime(1_000)
    const session = Session.create(SessionId('unpaired'))
    appendToolStep(session, 1, [])
    vi.setSystemTime(1_000 + 3_900_000)
    appendToolStep(session, 2, Array.from({ length: 25 }, () => ({ text: 'result '.repeat(200) })))
    session.append('tool/result', {
      turn: 2,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('never-called'),
        content: [{ type: 'text', text: 'unpaired result' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const { compact } = context(BASE)
    const preview = await compact.preview(session)
    expect(preview.entries).toHaveLength(20)
    expect(preview.entries.some(entry => entry.addressSeq === session.surface.nodes.at(-1))).toBe(false)
  })

  it('does not clear while an active subagent has an open turn', async () => {
    const session = busySession(25)
    const child = Session.create(SessionId('child'))
    child.append('turn/start', { turn: 1 })
    const { compact, ctx } = context(BASE)
    const store = { get: (id: SessionId) => id === child.header.id ? child : undefined }
    ctx.provide('sessions', store)
    ctx.provide('subagent', { listChildren: async () => [{ id: child.header.id }] })
    expect((await compact.preview(session)).skipped).toEqual([{ reason: 'active-subagent' }])
  })

  it('skips while a job is registered and unsettled', async () => {
    const session = busySession(25)
    session.append('job/registered', {
      jobId: 'job-1' as never,
      owner: session.header.id,
      kind: 'bash',
      label: 'running',
      startedAt: 1_000,
    })
    const { compact } = context(BASE)
    expect((await compact.preview(session)).skipped).toEqual([{ reason: 'active-job' }])
  })

  it('replays a cleared surface without re-clearing or losing the original', async () => {
    const session = busySession(25)
    const { compact } = context(BASE)
    const preview = await compact.preview(session)
    const originalSeq = preview.entries[0]!.addressSeq
    compact.apply(session, preview)
    const restored = Session.create(SessionId('restored'), session.snapshotEvents())
    const original = restored.eventAt(originalSeq)
    expect(original?.type).toBe('tool/result')
    const before = restored.snapshotEvents().length
    const again = await compact.preview(restored)
    expect(again.entries).toHaveLength(0)
    expect(restored.snapshotEvents()).toHaveLength(before)
  })

  it('heals a marker-only crash without losing the original content', async () => {
    const session = busySession(25)
    const { compact } = context(BASE)
    const targetSeq = session.surface.nodes.at(-1)!
    const target = session.eventAt(targetSeq)
    if (target?.type !== 'tool/result') throw new Error('expected a tool result')
    const original = session.deriveEventMessage(target) as { content: ContentBlock[] }
    session.append('compaction/prune', {
      shadowedRange: { start: targetSeq, end: targetSeq },
      shadowedSeqs: [targetSeq],
      shadowedTokenCount: 1,
    })
    expect(compact.healOrphanMarker(session)).toBe(true)
    const healed = session.snapshotEvents().at(-1)!
    expect(healed.type).toBe('tool/result')
    expect(JSON.stringify(session.deriveMessages())).toContain('old result')
    expect(original.content.length).toBeGreaterThan(0)
  })
})
