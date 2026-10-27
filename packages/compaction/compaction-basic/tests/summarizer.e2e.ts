import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it } from 'vitest'
import { summarizeWithLlm } from '../src/summarizer.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('default summarizer with real DeepSeek API', () => {
  it('follows the conversation language and retires a completed next step', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { thinking: 'disabled' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const provider = 'deepseek-official'
    const model = 'deepseek-v4-flash'
    const session = ctx.sessions.create(SessionId('real-summary-language'))
    const owner = { session, options: { provider, model } } as Agent
    const source = { provider, model }
    const priorCheckpoint = [
      '## Primary Request and Intent',
      '- 更新 packages/demo/README.md 并运行测试，不修改 src。',
      '## Key Technical Concepts',
      '- 上下文压缩与 checkpoint。',
      '## Files and Code',
      '- packages/demo/README.md 已更新。',
      '## Errors and Fixes',
      '- (none)',
      '## Pending Jobs',
      '- 汇报测试结果。',
      '## Current Work',
      '- 相关测试 161/161 通过，结果已经汇报。',
      '## Next Step',
      '- 汇报测试结果。',
      '## Critical Context',
      '- 不修改 src；等待用户确认。',
    ].join('\n')

    const result = await summarizeWithLlm(ctx, {
      summarizationProvider: provider,
      summarizationModel: model,
      maxTokens: 2_000,
    }, {
      messages: [
        createSystemMessage('你是一个编程助手。'),
        createUserMessage({
          content: [{ type: 'text', text: '更新 packages/demo/README.md 并运行测试，不要修改 src。' }],
          source: { kind: 'user' },
        }),
        createAssistantMessage({
          content: [{ type: 'text', text: 'README 已更新，相关测试 161/161 通过，未修改 src。' }],
          source,
        }),
        createUserMessage({
          content: [{ type: 'text', text: `<compacted-summary>${priorCheckpoint}</compacted-summary>` }],
          source: { kind: 'user' },
        }),
        createUserMessage({
          content: [{ type: 'text', text: '把结果告诉我，之后等我确认再继续。' }],
          source: { kind: 'user' },
        }),
        createAssistantMessage({
          content: [{ type: 'text', text: '结果已经汇报。接下来等待你的确认，不执行其他修改。' }],
          source,
        }),
      ],
    }, owner)

    const text = result.summary
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    const sections = text.split(/^## /m).slice(1)
    expect(sections).toHaveLength(9)
    for (const section of sections) {
      expect(section.split('\n', 1)[0]).toMatch(/[\u3400-\u9fff]/)
    }
    expect(sections[6]).toMatch(/\(none\)|等待/)
    expect(sections[6]).not.toContain('汇报测试结果')
    expect(text).toContain('packages/demo/README.md')
    expect(text).toContain('161/161')
    expect(text.split('汇报测试结果').length - 1).toBeLessThanOrEqual(1)
    console.info(`[summary-e2e] ${JSON.stringify({ usage: result.usage, summaryChars: text.length })}`)
  })
})
