/**
 * `/compact` running-Turn refusal: the decoration is available only while the
 * addressed Session reports `running`, and its action writes the localized
 * refusal to that Session's composer notice channel.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import type { CommandDecoration } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { registerCompactBusyNotice } from '../src/client/compact-busy.ts'

const sid = (id: string): SessionId => id as SessionId

async function bench() {
  const ctx = new Context()
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  ctx.provide('sessions', sessions)
  await sessions.add({ id: 'busy', snapshot: { running: true } })
  await sessions.add({ id: 'idle', snapshot: { running: false } })
  sessions.retainFor(ctx, sid('busy'))
  sessions.retainFor(ctx, sid('idle'))
  const notices: Array<{ sessionId: SessionId | undefined; level: 'info' | 'error'; text: string }> = []
  ctx.provide('conversation', {
    input: {
      for: (actx: Context) => ({
        notify: (level: 'info' | 'error', text: string) => {
          notices.push({ sessionId: sessions.scopeOf(actx), level, text })
        },
      }),
    },
  })
  const decorations = new Map<string, CommandDecoration>()
  ctx.provide('commandUi', {
    decorate: (decoration: CommandDecoration) => {
      decorations.set(decoration.name, decoration)
      return () => { decorations.delete(decoration.name) }
    },
  })
  let text = '正在回答，等这一轮结束后再压缩'
  await ctx.plugin({ apply: (plugin: Context) => { registerCompactBusyNotice(plugin, sessions, () => text) } }).await()
  return {
    decorations, notices,
    setText: (next: string) => { text = next },
  }
}

describe('registerCompactBusyNotice', () => {
  it('decorates bare /compact only while the addressed Session is running', async () => {
    const b = await bench()
    const decoration = b.decorations.get('compact')
    if (decoration === undefined) throw new Error('expected the compact decoration')
    expect(decoration.ui.kind).toBe('action')
    expect(decoration.available({ sessionId: sid('busy') })).toBe(true)
    expect(decoration.available({ sessionId: sid('idle') })).toBe(false)
    expect(decoration.available({ sessionId: sid('missing') })).toBe(false)
  })

  it('writes the current localized refusal to the addressed composer', async () => {
    const b = await bench()
    const decoration = b.decorations.get('compact')
    if (decoration?.ui.kind !== 'action') throw new Error('expected the compact action decoration')
    decoration.ui.run({ sessionId: sid('busy') })
    b.setText('A reply is in progress. Compact after this turn ends.')
    decoration.ui.run({ sessionId: sid('busy') })
    decoration.ui.run({ sessionId: sid('missing') })
    expect(b.notices).toEqual([
      { sessionId: sid('busy'), level: 'error', text: '正在回答，等这一轮结束后再压缩' },
      { sessionId: sid('busy'), level: 'error', text: 'A reply is in progress. Compact after this turn ends.' },
    ])
  })
})
