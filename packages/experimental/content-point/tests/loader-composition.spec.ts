/**
 * Real Loader composition: the row mounted from a cordis.yml beside the shipped
 * core plugins. A browser prompt recording two points — a data page's column
 * header and a block — reaches the model followed by the row's message writing
 * both key lines, the session log holds that message right after the prompt,
 * and the request of the turn's second step, after a tool call, and the next
 * turn's request each carry it once.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { ANCHOR_FORMAT, DESCRIBE_FORMAT, toPromptReference } from '@haoran/dsh-point-anchor'
import * as ContentPoint from '../src/index.ts'
import { blockData } from '../src/block.ts'
import { POINT_SOURCE } from '../src/text.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
})

/**
 * The text of a request's messages, one string per message.
 * @param messages - the request's messages.
 * @returns each message's text.
 */
function texts(messages: readonly RequestMessage[]): string[] {
  return messages.map(message => message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
}

it('appends the points of a browser prompt once, right after it, and every later request reads them once', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-content-point-composition-'))
  const configPath = join(root, 'cordis.yml')
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-experimental-content-point', ContentPoint],
  ])
  await writeFile(configPath, [...modules.keys()].map(name => `- name: '${name}'`).join('\n') + '\n')
  const context = ctx = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  // Without a Node internal loader the Loader imports bare names through this
  // test runner's module graph, which resolves workspace packages to `src`.
  context.loader.internal = undefined
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()

  const adapter = new MockAdapter([toolCallResponse('c1', 'look', {}), textResponse('名称这一列是图层的名字。'), textResponse('好的。')])
  context.llm.registerAdapter(['mock'], adapter)
  context.tools.register(defineContentToolFixture({
    name: 'look', description: 'look', parameters: {},
    async execute() { return [{ type: 'text', text: 'looked' }] },
  }))
  const agent = await context.agentLoop.create(SessionId('composed'), { provider: 'mock', model: 'mock' })
  const header = toPromptReference({
    v: DESCRIBE_FORMAT,
    anchorFormat: ANCHOR_FORMAT,
    what: { kind: 'data-page', region: 'table', part: 'header' },
    anchor: { kind: 'data-page', model: 'SpaceLayer', region: 'table', part: 'header', column: 'zh_label' },
    shown: { page: '图层配置', target: '名称' },
  }, POINT_SOURCE)
  const block = blockData({ seat: 'component', component: 'el.metric', node: 'rate', page: '图层配置', target: '指标' })
  if (header === undefined || block === undefined) throw new Error('fixture over the bound')
  const prompt = createUserMessage({
    content: [{ type: 'text', text: '这两处是什么' }],
    source: {
      kind: 'user',
      rpcId: brandString<SessionRequestId>('rpc-1'),
      references: [
        { source: header.source, label: header.label, data: JSON.parse(JSON.stringify(header.data)) as Record<string, never> },
        { source: POINT_SOURCE, label: '指标', data: JSON.parse(JSON.stringify(block)) as Record<string, never> },
      ],
    },
  })
  agent.followup(prompt)
  await agent.whenIdle()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '谢谢' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  expect(adapter.requests).toHaveLength(3)
  const [first, ...later] = adapter.requests
  const sent = texts(first?.messages ?? [])
  const at = sent.indexOf('这两处是什么')
  expect(at).toBeGreaterThan(-1)
  expect(sent[at + 1]).toContain('`data-page model=SpaceLayer region=table part=header column=zh_label`')
  expect(sent[at + 1]).toContain('`block seat=component component=el.metric node=rate`')
  for (const request of later) expect(texts(request.messages).filter(text => text.includes('锚点：'))).toHaveLength(1)

  const logged = agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.source)
  expect(logged.map(source => source.kind)).toEqual(['user', 'content-point', 'user'])
  expect(logged[1]).toMatchObject({ kind: 'content-point', message: prompt.id, form: 'notice' })
})
