/** V4 readers retain added source metadata and enforce the existing title discriminator. */
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const id = SessionId('merged-source-compatibility')
const sources: { name: string; source: SessionFormatJsonObject }[] = [
  { name: 'historical user without references', source: { kind: 'user', rpcId: 'request' } },
  { name: 'user with references', source: { kind: 'user', rpcId: 'request', references: [{ source: 'owner', label: '引用', data: { nested: [1, true, null] } }] } },
  { name: 'memory recall', source: { kind: 'memory-recall', queryDigest: 'query', hits: [{ sessionId: 'other', seq: 8, digest: 'excerpt' }] } },
  ...[{}, { form: 'instructions' }, { form: 'catalog' }, { form: 'snapshot', sections: [{ name: 'todos', text: 'Keep task' }] }, { form: 'notice', summary: 'Restored' }, { form: 'relay' }, { form: 'recall' }].map(form => ({
    name: `rehydration ${form.form ?? 'without form'}`,
    source: { kind: 'compaction-rehydration', compactionId: 'compact', compactionSeq: 3, digests: ['digest'], ...form } as SessionFormatJsonObject,
  })),
]
const modes = (['none', 'zstd'] as const).flatMap(compression => (['read', 'write'] as const).map(access => ({ compression, access })))

function rows(type: string, source: SessionFormatJsonObject) {
  const message = { id: 'input', role: type === 'developer/message' ? 'developer' : 'user', source, content: [{ type: 'text', text: 'Persisted context' }] }
  const data = type === 'user/message' ? message
    : type === 'developer/message' ? { turn: 1, step: 1, message }
      : type === 'agent/inbox/spliced' ? { target: 'next-turn', start: 0, inserted: [message] }
        : { titleProvider: 'test', messageSeqs: [2], route: { provider: 'test', model: 'test' }, system: 'Title', maxTokens: 20, messages: [message] }
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', surfaceOp: 'append', data: { id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue' }] } },
    { type, ...type === 'user/message' || type === 'developer/message' ? { surfaceOp: 'append' } : {}, data },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: seq + 1 }))
}

describe.each(modes)('merged source compatibility ($compression, $access)', ({ compression, access }) => {
  async function check(type: string, source: SessionFormatJsonObject, rejected = false) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-merged-source-'))
    const ctx = new Context()
    try {
      const header = { type: 'session', version: 4, id, createdAt: 1, delegationDepth: 0, isSeeded: false }
      const events = rows(type, source)
      const lines = [header, ...events].map(value => JSON.stringify(value) + '\n')
      const bytes = compression === 'none' ? Buffer.from(lines.join('')) : Buffer.concat(await Promise.all(lines.map(compressZstdFrame)))
      const path = generationLogPath(root, undefined, id, 4, compression)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
      await ctx.plugin(JsonlSessionPersistence, { root, compression })
      const opened = ctx.sessionPersistence.open(id, access)
      if (rejected) {
        await expect(opened).rejects.toThrow('session/title-llm-request messages do not represent messageSeqs')
      } else {
        const handle = await opened
        try {
          const restored = await handle.read()
          expect(restored.events).toEqual(events)
          const session = Session.fromRestore(id, restored.events, handle.header, SessionLogOffset(0), 'detached')
          const derived = session.deriveMessages()
          if (type === 'user/message' || type === 'developer/message') {
            expect(derived.at(-1)).toMatchObject({ source, content: [{ type: 'text', text: 'Persisted context' }] })
          } else {
            expect(derived).toHaveLength(1)
            expect(derived[0]?.source).toEqual({ kind: 'user' })
          }
        } finally {
          await handle.close()
        }
      }
      expect(await readFile(path)).toEqual(bytes)
      expect((await readdir(dirname(path))).filter(name => name !== 'session.lock')).toHaveLength(1)
    } finally {
      try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }

  describe.each(['user/message', 'developer/message', 'agent/inbox/spliced'])('%s', (type) => {
    it.each(sources)('preserves $name without the producer installed', async ({ source }) => {
      await check(type, source)
    })
  })

  it('preserves the existing title request and keeps it out of conversation history', async () => {
    await check('session/title-llm-request', { kind: 'dsh-session-title-llm' })
  })

  it.each(sources.filter(entry => entry.name !== 'historical user without references'))('refuses $name in a title request before exposing a handle or truncating bytes', async ({ source }) => {
    await check('session/title-llm-request', source, true)
  })
})
