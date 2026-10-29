import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId , createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SurfaceEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner, {
  codePointLength,
  DEFAULTS,
  originalToolResultSeq,
  PRUNE_MARKER,
  resolveConfig,
} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type {
  RecoverySpillRef,
  RecoverySpillStore,
  ToolResultPruneConfig,
} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { SpillLocator } from '@deepseek-ai/dsh-spill'
import { formatSpillNotice, hasSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'

const MODEL = 'test-model'
const SMALL: ToolResultPruneConfig = {
  thresholdChars: 50,
  headChars: 4,
  tailChars: 3,
}

function service(config: ToolResultPruneConfig = SMALL): ToolResultPruner {
  const ctx = new Context()
  // Service constructors self-register, so `ctx.tokenMeter` resolves for the
  // shadow-price pricing without a full plugin boot.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return new ToolResultPruner(ctx, config)
}

/** Pricing oracle mirroring the service's estimator for expectations. */
const METER_CTX = new Context()
new SessionProjectionRegistry(METER_CTX)
const METER = new TokenMeter(METER_CTX)

function appendToolStep(
  session: Session,
  turn: number,
  call: string,
  content: ContentBlock[],
  extra: Record<string, unknown> = {},
  name = 'bash',
): SessionSeq {
  const callId = ToolCallId(call)
  session.append('turn/start', {
    turn,
  })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
      source: {
        kind: 'model',
        ...{ provider: MODEL, model: MODEL },
      },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name, arguments: '{}' })
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: extra['error'] !== undefined }),
    ...extra,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

describe('tool-result pruning configuration', () => {
  it('preserves a logged image offload when pruning the same result later', () => {
    const session = Session.create(SessionId('prune-offloaded'), undefined, undefined, undefined, [imageOffloadProjection])
    const seq = appendToolStep(session, 1, 'shot', [
      { type: 'text', text: 'x'.repeat(200) },
      { type: 'image', attachment: {
        attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      } },
    ])
    session.append('image/offload', { targets: [{ seq: SessionSeq(seq), imageIndexes: [0] }] })
    const pruned = service().pruneSession(session)
    expect(pruned.pruned).toHaveLength(1)
    const replacement = session.snapshotEvents().at(-1)!
    expect(replacement.type).toBe('tool/result')
    expect(JSON.stringify(session.deriveEventMessage(replacement))).toContain('"offloaded":true')
    expect(JSON.stringify(Session.create(SessionId('restored-offloaded'), session.snapshotEvents(), undefined, undefined, [imageOffloadProjection]).deriveMessages())).toContain('"offloaded":true')
    expect(JSON.stringify(session.eventAt(SessionSeq(seq)))).not.toContain('offloaded')
  })

  it('resolves detached immutable defaults and partial overrides', () => {
    const raw = { thresholdChars: 100, headChars: 20, tailChars: 10 }
    const resolved = resolveConfig(raw)
    raw.headChars = 1
    expect(resolved).toEqual({ thresholdChars: 100, headChars: 20, tailChars: 10 })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(DEFAULTS).toEqual({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
  })

  it('rejects stale keys, invalid scalars, and an output budget above threshold', () => {
    const bad = [
      [{ thresholdChars: 0 }, /thresholdChars .* positive integer/],
      [{ headChars: -1 }, /headChars .* non-negative integer/],
      [{ tailChars: 1.5 }, /tailChars .* non-negative integer/],
      [{ thresholdChars: 50, headChars: 20, tailChars: 20 }, /headChars \+ marker \+ tailChars/],
      [{ threshold: 10 }, /unknown key "threshold"/],
    ] as Array<[unknown, RegExp]>
    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as ToolResultPruneConfig)).toThrow(pattern)
    }
  })
})

describe('ToolResultPruner content transform', () => {
  it('measures text code points only and skips content within threshold', () => {
    const prune = service()
    const blocks = [
      { type: 'text', text: 'a😀b' },
      { type: 'reasoning', text: 'not measured' },
    ] satisfies ContentBlock[]
    expect(prune.measureContent(blocks)).toBe(3)
    expect(prune.pruneContent(blocks)).toBeNull()
    expect(codePointLength('a😀b')).toBe(3)
  })

  it('keeps configured head and tail without splitting surrogate pairs', () => {
    const prune = service()
    const result = prune.pruneContent([{ type: 'text', text: '😀'.repeat(60) }])
    expect(result).toEqual([{
      type: 'text',
      text: `${'😀'.repeat(4)}${PRUNE_MARKER}${'😀'.repeat(3)}`,
    }])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(50)
    expect(result![0]).toMatchObject({ type: 'text' })
    expect((result![0] as { text: string }).text).not.toContain('\uFFFD')
  })

  it('preserves non-text blocks and their relative ordering across removed text', () => {
    const prune = service()
    const reasoning: ContentBlock = { type: 'reasoning', text: 'private-rich-block' }
    const call: ContentBlock = {
      type: 'tool-call',
      id: ToolCallId('nested'),
      name: 'nested',
      arguments: '{}',
    }
    const result = prune.pruneContent([
      { type: 'text', text: 'A'.repeat(40) },
      reasoning,
      { type: 'text', text: 'B'.repeat(30) },
      call,
      { type: 'text', text: 'C'.repeat(30) },
    ])
    expect(result).toEqual([
      { type: 'text', text: `AAAA${PRUNE_MARKER}` },
      reasoning,
      call,
      { type: 'text', text: 'CCC' },
    ])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(50)
  })

  it('supports zero-sized head and tail while still shrinking', () => {
    const prune = service({
      thresholdChars: codePointLength(PRUNE_MARKER),
      headChars: 0,
      tailChars: 0,
    })
    const result = prune.pruneContent([{ type: 'text', text: 'x'.repeat(100) }])
    expect(result).toEqual([{ type: 'text', text: PRUNE_MARKER }])
    expect(prune.measureContent(result!)).toBe(prune.config.thresholdChars)
  })
})

describe('ToolResultPruner session transaction', () => {
  it('prunes a stable snapshot, preserves all data, and cites the replaced result', () => {
    const session = Session.create(SessionId('preserve'))
    const originalSeq = appendToolStep(session, 1, 'one', [{
      type: 'text',
      text: 'x'.repeat(100),
    }], {
      isError: true,
      error: { name: 'ExitError', code: 'EXIT_1' },
      meta: { diff: ['a', 'b'] },
      futureField: { nested: true },
    })
    session.append('turn/start', {
      turn: 2,
    })

    const result = service().pruneSession(session)
    expect(result.pruned).toHaveLength(1)
    expect(result.charsRemoved).toBeGreaterThan(0)
    const entry = result.pruned[0]!
    expect(entry).toMatchObject({ originalSeq, callId: ToolCallId('one'), charsBefore: 100 })
    expect(entry.charsAfter).toBeLessThanOrEqual(50)

    const original = session.snapshotEvents()[originalSeq]!
    const replacement = session.snapshotEvents()[entry.replacementSeq]! as SurfaceEvent
    expect(original).toMatchObject({
      type: 'tool/result',
      data: {
        message: {
          content: [{ type: 'text', text: 'x'.repeat(100) }],
        },
      },
    })
    expect(replacement).toMatchObject({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        isError: true,
        message: {
          source: { kind: 'tool', callId: ToolCallId('one') },
          role: 'tool',
          toolCallId: ToolCallId('one'),
          isError: true,
        },
        error: { name: 'ExitError', code: 'EXIT_1' },
        meta: { diff: ['a', 'b'] },
        futureField: { nested: true },
      },
      surfaceOp: { op: 'replace', startSeq: originalSeq, endSeq: originalSeq },
      sourceEventSeqs: [originalSeq],
    })
    expect(session.surface.nodes).not.toContain(originalSeq)

    // Shadow-price protocol: the metering event sits directly before the
    // replacement and prices the shadowed node with the shared estimator.
    if (original.type !== 'tool/result') throw new Error('original is not a tool/result')
    expect(session.snapshotEvents()[entry.replacementSeq - 1]).toMatchObject({
      type: 'compaction/prune',
      data: {
        shadowedRange: { start: originalSeq, end: originalSeq },
        shadowedSeqs: [originalSeq],
        shadowedTokenCount: METER.estimateMessage(original.data.message),
      },
    })
  })

  it('prunes multiple results, skips short ones, and converges in one pass', () => {
    const session = Session.create(SessionId('multiple'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(100) }])
    appendToolStep(session, 2, 'b', [{ type: 'text', text: 'short' }])
    appendToolStep(session, 3, 'c', [{ type: 'text', text: 'C'.repeat(80) }])
    session.append('turn/start', {
      turn: 4,
    })
    const prune = service()
    const first = prune.pruneSession(session)
    const second = prune.pruneSession(session)
    expect(first.pruned.map(entry => entry.callId)).toEqual([ToolCallId('a'), ToolCallId('c')])
    expect(first.charsRemoved).toBe(
      first.pruned.reduce((sum, entry) => sum + entry.charsBefore - entry.charsAfter, 0),
    )
    expect(second).toEqual({ pruned: [], charsRemoved: 0 })
  })

  it('replays to the identical pruned model messages', () => {
    const session = Session.create(SessionId('replay'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(100) }])
    session.append('turn/start', {
      turn: 2,
    })
    service().pruneSession(session)
    const replay = Session.create(session.id, session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
    expect(replay.surface.replaceGeneration).toBe(session.surface.replaceGeneration)
  })
})


describe('ToolResultPruner recovery addresses', () => {
  const RECOVERY: ToolResultPruneConfig = {
    thresholdChars: 1600,
    headChars: 80,
    tailChars: 40,
  }

  class FakeSpillStore implements RecoverySpillStore {
    readonly saves: Array<Parameters<RecoverySpillStore['saveText']>[0]> = []

    constructor(private readonly failure?: Error) {}

    async saveText(request: Parameters<RecoverySpillStore['saveText']>[0]): Promise<RecoverySpillRef> {
      this.saves.push(request)
      if (this.failure !== undefined) throw this.failure
      return {
        locator: SpillLocator(`/tmp/spill/${request.suggestedName}`),
        bytes: Buffer.byteLength(request.content),
        retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
      }
    }
  }

  function textAt(session: Session, seq: number): string {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type !== 'tool/result') throw new Error(`seq ${seq} is not a tool/result`)
    const message = session.deriveEventMessage(event)
    if (message === null) throw new Error(`seq ${seq} has no derived message`)
    return message.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
  }

  function appendReplacement(session: Session, cited: SessionSeq, text: string): SessionSeq {
    const original = session.eventAt(cited)
    if (original?.type !== 'tool/result') throw new Error('cited event is not a tool/result')
    const message = session.deriveEventMessage(original) as ToolResultMessage
    return session.append('tool/result', {
      ...original.data,
      message: { ...message, content: [{ type: 'text', text }] },
    }, {
      surfaceOp: { op: 'replace', startSeq: cited, endSeq: cited },
      sourceEventSeqs: [cited],
    }).seq
  }

  it('addresses the original log event by default and writes nothing', async () => {
    const session = Session.create(SessionId('recovery-session-address'))
    const originalSeq = appendToolStep(session, 1, 'big', [{ type: 'text', text: 'x'.repeat(2000) }])
    const store = new FakeSpillStore()
    const result = await service(RECOVERY).pruneSessionWithRecovery(session, { spillStore: store })

    expect(store.saves).toHaveLength(0)
    expect(result.pruned).toHaveLength(1)
    expect(result.pruned[0]!.recovery).toMatchObject({
      kind: 'session',
      sessionId: session.id,
      seq: originalSeq,
    })
    const replacement = textAt(session, result.pruned[0]!.replacementSeq)
    expect(replacement).toContain(`seq ${String(originalSeq)}`)
    expect(replacement).toContain('session_event_read')
    expect(replacement).toContain('untrusted data')
    // The original stays byte-identical and readable at its logged address.
    expect(textAt(session, originalSeq)).toBe('x'.repeat(2000))
  })

  it('reuses a recorded spill notice exactly and never saves again', async () => {
    const notice = formatSpillNotice(
      { kind: 'exact', count: 1234 },
      { locator: SpillLocator('/tmp/spill/kept.txt'), retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' },
    )
    const session = Session.create(SessionId('recovery-existing-spill'))
    const originalSeq = appendToolStep(session, 1, 'spilled', [{
      type: 'text',
      text: `${'x'.repeat(3000)}\n\n${notice}`,
    }])
    const store = new FakeSpillStore()
    const result = await service(RECOVERY).pruneSessionWithRecovery(session, { spillStore: store })

    expect(store.saves).toHaveLength(0)
    expect(result.pruned[0]!.recovery.kind).toBe('spill')
    const replacement = textAt(session, result.pruned[0]!.replacementSeq)
    expect(replacement).toContain(notice)
    expect(replacement.split('/tmp/spill/kept.txt')).toHaveLength(2)
    expect(textAt(session, originalSeq)).toBe(`${'x'.repeat(3000)}\n\n${notice}`)
  })

  it('saves complete text once in spill mode and reuses the cache on a second pass', async () => {
    const session = Session.create(SessionId('recovery-spill-save'))
    const originalSeq = appendToolStep(session, 1, 'big', [{ type: 'text', text: 'y'.repeat(2000) }])
    const store = new FakeSpillStore()
    const pruner = service(RECOVERY)
    const first = await pruner.pruneSessionWithRecovery(session, { address: 'spill', spillStore: store })

    expect(store.saves).toHaveLength(1)
    expect(store.saves[0]).toMatchObject({
      owner: { sessionId: session.id },
      source: { kind: 'tool', toolName: 'bash', callId: ToolCallId('big'), label: 'result' },
      content: 'y'.repeat(2000),
    })
    expect(first.pruned[0]!.recovery.kind).toBe('spill')
    const replacementText = textAt(session, first.pruned[0]!.replacementSeq)
    expect(replacementText).toContain('/tmp/spill/tool-result-')
    expect(hasSpillNotice(replacementText)).toBe(true)

    const second = await pruner.pruneSessionWithRecovery(session, { address: 'spill', spillStore: store })
    expect(second.pruned).toHaveLength(0)
    expect(store.saves).toHaveLength(1)
    expect(originalSeq).toBeGreaterThanOrEqual(0)
  })

  it('follows consecutive replacements and intervening events to the original result', async () => {
    const session = Session.create(SessionId('recovery-chain'))
    const originalSeq = appendToolStep(session, 1, 'big', [{ type: 'text', text: 'z'.repeat(2000) }])
    const first = appendReplacement(session, originalSeq, 'a'.repeat(2000))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const second = appendReplacement(session, first, 'b'.repeat(2000))

    expect(originalToolResultSeq(session, second)).toBe(originalSeq)
    const result = await service(RECOVERY).pruneSessionWithRecovery(session)
    expect(result.pruned[0]!.recovery).toMatchObject({ kind: 'session', seq: originalSeq })
    expect(textAt(session, result.pruned[0]!.replacementSeq)).toContain(`seq ${String(originalSeq)}`)
  })

  it('covers a large read result through the same session address', async () => {
    const session = Session.create(SessionId('recovery-read'))
    const originalSeq = appendToolStep(session, 1, 'read-file', [{
      type: 'text',
      text: 'r'.repeat(2000),
    }], {}, 'read')
    const result = await service(RECOVERY).pruneSessionWithRecovery(session)
    expect(result.pruned[0]!.recovery).toMatchObject({ kind: 'session', seq: originalSeq })
  })

  it('falls back to the session address when a forced spill fails', async () => {
    const session = Session.create(SessionId('recovery-failed-save'))
    appendToolStep(session, 1, 'big', [{ type: 'text', text: 'q'.repeat(2000) }])
    const store = new FakeSpillStore(new Error('no space left'))
    const result = await service(RECOVERY).pruneSessionWithRecovery(session, { address: 'spill', spillStore: store })

    expect(store.saves).toHaveLength(1)
    expect(result.pruned[0]!.recovery.kind).toBe('session')
    const replacement = textAt(session, result.pruned[0]!.replacementSeq)
    expect(replacement).toContain('seq ')
    expect(replacement).not.toContain('Full formatted result stored at:')
    expect(replacement).not.toContain('/tmp/spill/')
  })

  it('falls back to the session address when no spill backend is available', async () => {
    const session = Session.create(SessionId('recovery-no-store'))
    const originalSeq = appendToolStep(session, 1, 'big', [{ type: 'text', text: 'n'.repeat(2000) }])
    const result = await service(RECOVERY).pruneSessionWithRecovery(session, { address: 'spill' })
    expect(result.pruned[0]!.recovery).toMatchObject({ kind: 'session', seq: originalSeq })
  })

  it('keeps an image-bearing result unchanged when no address can be produced', async () => {
    const session = Session.create(SessionId('recovery-image-unavailable'))
    const image: ContentBlock = {
      type: 'image',
      attachment: {
        attachmentId: `sha256:${'e'.repeat(64)}` as never,
        mediaType: 'image/png',
        bytes: 1,
        width: 1,
        height: 1,
      },
    }
    const originalSeq = appendToolStep(session, 1, 'shot', [
      { type: 'text', text: 'screenshot '.repeat(300) },
      image,
    ])
    const store = new FakeSpillStore()
    const result = await service(RECOVERY).pruneSessionWithRecovery(session, { address: 'spill', spillStore: store })
    expect(result.pruned).toHaveLength(0)
    expect(result.noAddress).toBe(1)
    expect(store.saves).toHaveLength(0)
    expect(session.surface.nodes).toContain(originalSeq)
  })

  it('previews a concrete replacement message, then applies it once', async () => {
    const session = Session.create(SessionId('recovery-preview-apply'))
    const originalSeq = appendToolStep(session, 1, 'big', [{ type: 'text', text: 'p'.repeat(2000) }])
    const original = session.deriveEventMessage(session.eventAt(originalSeq)!) as ToolResultMessage
    const pruner = service(RECOVERY)
    const before = session.snapshotEvents().length

    const preview = pruner.previewSessionPrune(session)
    expect(session.snapshotEvents()).toHaveLength(before)
    expect(preview.entries).toHaveLength(1)
    expect(preview.entries[0]!.original.id).toBe(original.id)
    expect(preview.entries[0]!.message.id).toBe(original.id)
    expect(preview.entries[0]!.message.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .toContain(`seq ${String(originalSeq)}`)
    expect(preview.entries[0]!.address.kind).toBe('session')
    expect(preview.reclaimableChars).toBeGreaterThan(0)
    expect(preview.reclaimableTokens).toBeGreaterThan(0)

    const applied = await pruner.applyPrunePreview(session, preview)
    expect(applied.pruned).toHaveLength(1)
    expect(textAt(session, applied.pruned[0]!.replacementSeq)).toContain(`seq ${String(originalSeq)}`)

    const again = await pruner.applyPrunePreview(session, preview)
    expect(again.pruned).toHaveLength(0)
    expect(again.notOnSurface).toBe(1)
  })

  it('keeps a non-text result out of preview instead of pricing it heuristically', async () => {
    const session = Session.create(SessionId('recovery-preview-non-text'))
    const image: ContentBlock = {
      type: 'image',
      attachment: {
        attachmentId: `sha256:${'f'.repeat(64)}` as never,
        mediaType: 'image/png',
        bytes: 1,
        width: 1,
        height: 1,
      },
    }
    const originalSeq = appendToolStep(session, 1, 'shot', [
      { type: 'text', text: 'screenshot '.repeat(300) },
      image,
    ])
    const before = session.snapshotEvents().length
    const preview = service(RECOVERY).previewSessionPrune(session)
    expect(preview.entries).toHaveLength(0)
    expect(preview.skipped).toEqual([{ originalSeq, reason: 'non-text' }])
    expect(session.snapshotEvents()).toHaveLength(before)
    expect(session.surface.nodes).toContain(originalSeq)
  })

  it('marks a deferred spill candidate as not previewable and writes nothing', async () => {
    const session = Session.create(SessionId('recovery-preview-deferred'))
    const originalSeq = appendToolStep(session, 1, 'big', [{ type: 'text', text: 'd'.repeat(2000) }])
    const store = new FakeSpillStore()
    const before = session.snapshotEvents().length
    const preview = service(RECOVERY).previewSessionPrune(session, { address: 'spill', spillStore: store })
    expect(preview.entries).toHaveLength(0)
    expect(preview.skipped).toEqual([{ originalSeq, reason: 'spill-deferred' }])
    expect(store.saves).toHaveLength(0)
    expect(session.snapshotEvents()).toHaveLength(before)
  })

  it('skips preview entries whose seq a summary replacement shadowed', async () => {
    const session = Session.create(SessionId('recovery-preview-shadowed'))
    const originalSeq = appendToolStep(session, 1, 'big', [{ type: 'text', text: 'm'.repeat(2000) }])
    const pruner = service(RECOVERY)
    const preview = pruner.previewSessionPrune(session)
    expect(preview.entries).toHaveLength(1)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'test' },
    }), {
      surfaceOp: { op: 'replace', startSeq: originalSeq, endSeq: originalSeq },
      sourceEventSeqs: [originalSeq],
    })
    const applied = await pruner.applyPrunePreview(session, preview)
    expect(applied.pruned).toHaveLength(0)
    expect(applied.notOnSurface).toBe(1)
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/prune')).toHaveLength(0)
  })

  it('leaves the result untouched when its recovery notice cannot fit the budget', async () => {
    const session = Session.create(SessionId('recovery-notice-too-large'))
    const originalSeq = appendToolStep(session, 1, 'big', [{ type: 'text', text: 'w'.repeat(2000) }])
    const result = await service(SMALL).pruneSessionWithRecovery(session)
    expect(result.pruned).toHaveLength(0)
    expect(result.noticeDropped).toBe(1)
    expect(result.noAddress).toBe(0)
    expect(session.surface.nodes).toContain(originalSeq)
    expect(textAt(session, originalSeq)).toBe('w'.repeat(2000))
  })

  it('writes nothing when the result is below the pruning threshold', async () => {
    const session = Session.create(SessionId('recovery-below-threshold'))
    appendToolStep(session, 1, 'small', [{ type: 'text', text: 's'.repeat(100) }])
    const store = new FakeSpillStore()
    const result = await service(RECOVERY).pruneSessionWithRecovery(session, { address: 'spill', spillStore: store })
    expect(result.pruned).toHaveLength(0)
    expect(store.saves).toHaveLength(0)
  })

  it('writes nothing when the notice cannot fit, even in spill mode', async () => {
    const session = Session.create(SessionId('recovery-notice-too-large-spill'))
    const originalSeq = appendToolStep(session, 1, 'big', [{ type: 'text', text: 'v'.repeat(2000) }])
    const store = new FakeSpillStore()
    const result = await service(SMALL).pruneSessionWithRecovery(session, { address: 'spill', spillStore: store })
    expect(result.pruned).toHaveLength(0)
    expect(result.noticeDropped).toBe(1)
    expect(result.noAddress).toBe(0)
    expect(store.saves).toHaveLength(0)
    expect(session.surface.nodes).toContain(originalSeq)
  })
})
