import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as clock from '../../../snapshots/desktop/session-query-turn/clock.ts'

test('the fixture supplies real Session event times and restores the prior clock on disposal', async () => {
  const original = Date.now
  const ctx = new Context()
  const fiber = await ctx.plugin(clock)
  try {
    const session = Session.create(SessionId('desktop-clock-test'))
    const event = session.append('turn/start', { turn: 1 })
    assert.equal(event.time, 1767225600000)
    assert.equal(session.snapshotEvents()[0]?.time, event.time)
    assert.equal(Date.now(), event.time)
  } finally {
    await fiber.dispose()
  }
  assert.equal(Date.now, original)
})

test('the fixture preserves arbitrary timestamp text in Session payloads', async () => {
  const original = Date.now
  const ctx = new Context()
  const fiber = await ctx.plugin(clock)
  const text = '1767225600000\n  "time": 1794539722903,\n  "time": 1767225600000,'
  try {
    const session = Session.create(SessionId('desktop-clock-text'))
    const event = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    assert.equal(event.time, 1767225600000)
    assert.deepEqual(event.data.content, [{ type: 'text', text }])
    assert.deepEqual(session.snapshotEvents()[0]?.data, event.data)
  } finally {
    await fiber.dispose()
  }
  assert.equal(Date.now, original)
})
