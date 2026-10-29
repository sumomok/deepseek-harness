// @vitest-environment node
/**
 * Replay a real Claude Code transcript through this harness's pressure
 * compaction, in a synthetic session that keeps the transcript's own message
 * order, turn boundaries, tool pairing and text sizes.
 *
 * The comparison target is the same transcript's own published compact
 * metadata (`preTokens` / `postTokens` on its `compact_boundary` record). Both
 * sides are token counts; no model judges anything. The summary is a fixed
 * stand-in, so the run costs no request.
 *
 * Skipped unless `CLAUDE_SESSION_FILE` names a transcript.
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createSystemMessage, createUserMessage, LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import BasicCompactionEngine from '../src/index.ts'
import type { SummarizationInput } from '../src/summarizer.ts'

const MODEL = 'experiment-model'
const WINDOW = 1_000_000
const SIGNAL = new AbortController().signal
const TRANSCRIPT = process.env.CLAUDE_SESSION_FILE

class ContextAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindow } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const SUMMARY: ContentBlock[] = [{ type: 'text', text: 'checkpoint '.repeat(400).trim() }]

class ExperimentEngine extends BasicCompactionEngine {
  override async summarize(
    _input: SummarizationInput,
    _agent: never,
    _signal?: AbortSignal,
  ): Promise<{ summary: ContentBlock[]; provider: string; model: string }> {
    return { summary: SUMMARY, provider: 'experiment', model: 'experiment' }
  }
}

interface Record { type: string; message?: { role?: string; content?: unknown }; subtype?: string }

/** One text block's text, whatever the block list looks like. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: { type?: string; text?: string }) => (block.type === 'text' || block.type === 'tool_result' ? (block.text ?? '') : ''))
    .join('\n')
}

/** The tool-result blocks of one record, with the ids they answer. */
function toolResultsOf(content: unknown): { id: string; text: string }[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((block: { type?: string }) => block.type === 'tool_result')
    .map((block: { tool_use_id?: string; content?: unknown }) => ({
      id: block.tool_use_id ?? 'unknown',
      text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
    }))
}

/** The tool-call ids one assistant record requested. */
function toolCallsOf(content: unknown): { id: string; name: string; args: string }[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((block: { type?: string }) => block.type === 'tool_use')
    .map((block: { id?: string; name?: string; input?: unknown }) => ({
      id: block.id ?? 'unknown',
      name: block.name ?? 'tool',
      args: JSON.stringify(block.input ?? {}),
    }))
}

/**
 * Rebuild one transcript segment — the records between two compact boundaries —
 * as a session this harness can measure.
 * @param records - the segment's records, in order.
 * @returns the session, with a turn left open like a live one.
 */
function replay(records: Record[]): Session {
  const session = Session.create(SessionId('claude-replay'))
  let turn = 0
  let step = 0
  let opened = false
  let headerWritten = false
  const openTurn = (): void => {
    if (opened) return
    turn += 1
    step = 1
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step })
    if (!headerWritten) {
      session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
      headerWritten = true
    }
    opened = true
  }
  const closeTurn = (): void => {
    if (!opened) return
    session.append('step/end', { turn, step })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    opened = false
  }

  for (const [index, record] of records.entries()) {
    if (record.type === 'user') {
      const results = toolResultsOf(record.message?.content)
      if (results.length > 0) {
        openTurn()
        for (const result of results) {
          const callId = ToolCallId(result.id)
          session.append('tool/result', {
            turn,
            step,
            message: createMessage({
              role: 'tool',
              source: { kind: 'tool', callId },
              toolCallId: callId,
              content: [{ type: 'text', text: result.text }],
            }),
          }, { surfaceOp: 'append' })
        }
        continue
      }
      closeTurn()
      openTurn()
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: textOf(record.message?.content) }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      continue
    }
    if (record.type !== 'assistant') continue
    const content = record.message?.content
    const calls = toolCallsOf(content)
    const text = textOf(content)
    openTurn()
    if (index === 0 && text.length > 0) {
      session.append('system/message', { turn, step, message: createSystemMessage(text) }, { surfaceOp: 'append' })
      continue
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step,
      message: createMessage({
        role: 'assistant',
        content: [
          ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
          ...calls.map(call => ({ type: 'tool-call' as const, id: ToolCallId(call.id), name: call.name, arguments: call.args })),
        ],
        source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    for (const call of calls) {
      session.append('tool/call', { turn, step, callId: ToolCallId(call.id), name: call.name, arguments: call.args })
    }
  }
  closeTurn()
  session.append('turn/start', { turn: turn + 1 })
  return session
}

/** The transcript's records, split into the segments its own compactions mark. */
function segments(): Record[][] {
  const text = readFileSync(TRANSCRIPT ?? '', 'utf8')
  const all = text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Record] } catch { return [] }
  })
  const out: Record[][] = [[]]
  for (const record of all) {
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      out.push([])
      continue
    }
    if (record.type === 'user' || record.type === 'assistant') out[out.length - 1]?.push(record)
  }
  return out
}

describe.skipIf(TRANSCRIPT === undefined)('replay of a real transcript', () => {
  it('reports what each retainTokens setting would leave behind', async () => {
    const all = segments()
    // The segment the transcript itself compacted is the last one before a
    // boundary; its own metadata records the pre/post it reached.
    const target = all.slice(0, -1).sort((left, right) => right.length - left.length)[0] ?? []
    const rows: string[] = []
    for (const share of [0.16, 0.08, 0.04, 0.02, 0.005]) {
      const retainTokens = Math.round(WINDOW * share)
      const ctx = new Context()
      void new LlmRuntime(ctx)
      new SessionProjectionRegistry(ctx)
      void new TokenMeter(ctx)
      ctx.llm.registerAdapter([MODEL, 'actual'], new ContextAdapter(WINDOW))
      const engine = new ExperimentEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 8192, thresholdRatio: 0.4, retainTokens })
      const session = replay(target)
      const before = ctx.tokenMeter.measure(session).surfaceTokens
      await engine.compactIfNeeded({ session, options: { provider: MODEL, model: MODEL } } as never, 'pressure', SIGNAL)
      const after = ctx.tokenMeter.measure(session).surfaceTokens
      rows.push(`retain=${String(retainTokens).padStart(7)}  before=${String(before).padStart(8)}  after=${String(after).padStart(8)}  ratio=${(((before - after) / before) * 100).toFixed(1)}%`)
    }
    // eslint-disable-next-line no-console -- the table is this experiment's output
    console.log(`\nrecords=${String(target.length)}\n${rows.join('\n')}\n`)
    expect(rows).toHaveLength(5)
  }, 120_000)
})
