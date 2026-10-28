import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobNotify, JobOutcome } from '@deepseek-ai/dsh-jobs'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { ScriptedAdapter } from './scripted-adapter.ts'

const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

function textChunks(value: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Run one policy: start a job, let the owner go idle, settle it, then speak again. */
async function runPolicy(label: string, options: { quietConfig?: boolean; notify?: JobNotify }) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs, options.quietConfig === true ? { completionDelivery: 'quiet' } : {})
  const adapter = new ScriptedAdapter([])
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId(`wake-${label}`), agentOptions: { provider: 'mock', model: 'mock' } })
  const agent = handle.agent
  const done = Promise.withResolvers<JobOutcome>()
  adapter.push(textChunks('working on it'))
  try {
    agent.followup(message('start the long job'))
    await agent.whenIdle()
    const id = ctx.jobs.start({
      kind: 'bash',
      label: 'long producer',
      owner: agent.id,
      ...options.notify === undefined ? {} : { notify: options.notify },
      run(job) {
        job.append('produced output\n')
        return { done: done.promise, cancel: () => { done.resolve({ status: 'killed' }) } }
      },
    })
    const idleBefore = adapter.requests.length
    done.resolve({ status: 'completed' })
    await setImmediate()
    await setImmediate()
    await agent.whenIdle()
    await setImmediate()
    const wokeOnItsOwn = adapter.requests.length > idleBefore
    adapter.push(textChunks('looking at the new request'))
    agent.followup(message('UNRELATED_NEW_REQUEST'))
    await agent.whenIdle()
    const last = adapter.requests[adapter.requests.length - 1]
    const messages = (last?.messages ?? []).map(m => JSON.stringify(m))
    const noticeAt = messages.findIndex(text => text.includes(id))
    const requestAt = messages.findIndex(text => text.includes('UNRELATED_NEW_REQUEST'))
    return { label, wokeOnItsOwn, noticeAt, requestAt, turns: adapter.requests.length }
  } finally {
    done.resolve({ status: 'completed' })
    agent.cancel({ kind: 'user' })
    await handle.dispose()
    await ctx.fiber.dispose()
  }
}

describe('what a settlement does to an idle owner', () => {
  it('reports each policy', async () => {
    const rows = [
      await runPolicy('A 总是唤醒', {}),
      await runPolicy('B 永不唤醒', { quietConfig: true }),
      await runPolicy('C quiet', { notify: 'quiet' }),
      await runPolicy('C wake', { notify: 'wake' }),
    ]
    const table = rows.map(row => `${row.label.padEnd(12)} 自动开新轮=${row.wokeOnItsOwn ? '是' : '否'}  `
      + `下一轮请求里：通知在第 ${row.noticeAt} 条，用户消息在第 ${row.requestAt} 条（共 ${row.turns} 轮）`)
    console.log(`\n${table.join('\n')}\n`)
    const [always, never, quiet, wake] = rows
    // Only a producer that asked for it, or a configuration that always wakes,
    // opens a turn on an idle owner.
    expect(always?.wokeOnItsOwn).toBe(true)
    expect(never?.wokeOnItsOwn).toBe(false)
    expect(quiet?.wokeOnItsOwn).toBe(false)
    expect(wake?.wokeOnItsOwn).toBe(true)
    // Either way the notice reaches the owner's next request, ahead of the
    // message that request carries.
    for (const row of rows) {
      expect(row.noticeAt).toBeGreaterThanOrEqual(0)
      expect(row.noticeAt).toBeLessThan(row.requestAt)
    }
  }, 60_000)
})
