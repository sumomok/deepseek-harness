/**
 * REAL-composition coverage for the return channel: a test-only cordis.yml
 * booted through the vendored Loader mounts the command registry, the
 * projection registry, and the content-surface router, and the assertions
 * observe what the composed application does when a block reports a press —
 * that the command exists at all, the record the log keeps of it, the words
 * handed to the agent, and the deployment gate still standing in front of
 * whatever the model reaches for next.
 *
 * The turn a `wake` opens is not asserted here and cannot be: opening one needs
 * `dsh-agent-loop`, a Host-aggregate package, and this package is registered in
 * the Client aggregate, where the two `Context` merges collide. The composed
 * turn — `turn/start`, the notice claimed into it, and that notice reaching the
 * model's next request, which the scripted reply is built out of — is asserted
 * over the shipped console instead, by
 * `apps/web/tests/component-surface.e2e.ts`, which drives a real browser
 * against a real server. What this file pins is everything up to the handover.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import {
  COMPONENT_ACTION_COMMAND,
  COMPONENT_ACTION_PLUGIN,
  CONFIRM_BAR_ID,
  CONFIRM_BAR_PRESS_ID,
  formatComponentActionLine,
} from '../src/component-call.ts'
import * as ShowComponent from '../src/index.ts'

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

const signal = new AbortController().signal

const SPEC = {
  nodes: [{
    id: 'bar',
    component: CONFIRM_BAR_ID,
    props: { buttons: [{ id: 'delete', label: '删除' }, { id: 'keep', label: '保留' }] },
  }],
}

const PRESS_LINE = formatComponentActionLine({
  entryId: 'budget',
  componentId: CONFIRM_BAR_ID,
  actionId: CONFIRM_BAR_PRESS_ID,
  nodeId: 'bar',
  payload: { buttonId: 'delete' },
})

/** What the agent is told a press was, verbatim. */
const PRESS_TEXT = 'The user pressed "删除" in content panel entry "budget" ("确认删除"), on the 确认条 block "bar".'

/** Write a cordis.yml and boot it through the real Loader. */
async function loadComposition(): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-component-action-'))
  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-tool-todo'",
    '  config:',
    '    allowParallelInProgress: false',
    "- name: '@deepseek-ai/dsh-experimental-content-surface'",
    '- id: show-component',
    "  name: '@deepseek-ai/dsh-experimental-component-surface'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(world).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-tool-todo', ToolTodo],
    ['@deepseek-ai/dsh-experimental-content-surface', ContentSurfaceRegistry],
    ['@deepseek-ai/dsh-experimental-component-surface', ShowComponent],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/**
 * An idle agent already showing one confirmation bar.
 *
 * The agent is a stand-in for the loop's own: what every assertion below reads
 * is the session it carries and the delivery method the handler reached for.
 * @param ctx - the loaded composition.
 * @param followup - what to do with the message a wake hands over.
 * @returns the registered agent.
 */
function agentShowingTheBar(ctx: Context, followup: (message: UserMessage) => void = () => {}): Agent {
  const session: Session = (ctx.get('sessions') as unknown as SessionStore).create()
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: ToolCallId('call-1'),
    name: 'show_component',
    arguments: JSON.stringify({ id: 'budget', title: '确认删除', spec: SPEC }),
  })
  const scopeFiber = ctx.plugin(() => {})
  const agent = {
    id: session.id,
    ctx: scopeFiber.ctx,
    session,
    inject: (): void => {},
    followup,
    status: 'idle',
  } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

describe('a press on the composed console', () => {
  it('hands the agent the account the catalog and the entry\'s own spec build', async () => {
    const ctx = await loadComposition()
    const followup = vi.fn()
    const agent = agentShowingTheBar(ctx, followup)

    const execution = await ctx.commands.execute(agent, PRESS_LINE, [], signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([{ type: 'text', text: PRESS_TEXT }])
    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: COMPONENT_ACTION_PLUGIN,
      form: 'notice',
      summary: '用户在「确认删除」里点了「删除」',
    })
  })

  it('leaves the log carrying the action line verbatim and no event of its own', async () => {
    const ctx = await loadComposition()
    const agent = agentShowingTheBar(ctx)

    await ctx.commands.execute(agent, PRESS_LINE, [], signal)

    const run = agent.session.snapshotEvents().find(event => event.type === 'command/run')
    expect(run?.type === 'command/run' && run.data).toMatchObject({
      name: COMPONENT_ACTION_COMMAND,
      args: PRESS_LINE.slice(`/${COMPONENT_ACTION_COMMAND}`.length),
      source: { kind: 'user' },
    })
    expect(agent.session.snapshotEvents().map(event => event.type)).toContain('command/done')
    expect(agent.session.snapshotEvents().filter(event => event.type.startsWith('component'))).toEqual([])
  })

  it('publishes what became of the press, per block, so a redrawn block still reads as pressed', async () => {
    // The seat that drew the bar is discarded whenever the user looks at
    // something else, so what a redrawn block reads is this value rather than
    // anything the block remembered.
    const ctx = await loadComposition()
    const agent = agentShowingTheBar(ctx)

    await ctx.commands.execute(agent, PRESS_LINE, [], signal)

    const published = ctx.sessionProjections.snapshot(agent.session).values.componentActions
    const run = agent.session.snapshotEvents().find(event => event.type === 'command/run')
    expect(published).toEqual({
      actions: [{ entryId: 'budget', nodeId: 'bar', seq: run?.seq, outcome: 'sent' }],
    })
  })

  it('adds no gate of its own, and leaves this composition\'s tools/pre-execute policy deciding a write', async () => {
    // This row places no write tool and asks for no approval of its own: a
    // command handler can run with no turn open, and `approval.request()`
    // throws there. The gate the design relies on is the deployment's own
    // `tools/pre-execute` policy over whatever write tool the model reaches for
    // in the turn a press opened. What this composition can show is the half
    // that is local to it: with this row loaded, that policy is still what
    // decides an existing write tool, and the tool body does not run. The other
    // half — that the write happens in the turn a press opened — needs a loop
    // this aggregate cannot boot, and is the browser scenario's.
    const ctx = await loadComposition()
    const agent = agentShowingTheBar(ctx)
    ctx.on('tools/pre-execute', (exec, next) => (
      exec.name === 'todo_write'
        ? Promise.resolve({ kind: 'ask' as const, reason: 'writing needs the user\'s say-so' })
        : next()
    ))

    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('call-2'),
      name: 'todo_write',
      arguments: { todos: [{ content: '删除这条记录', status: 'in_progress' }] },
      agent,
    })

    // No approval service is composed here, so `ask` settles as a denial
    // carrying the policy's own reason: what this pins is that the decision is
    // taken, and the tool body skipped, before anything is written.
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: "Error: writing needs the user's say-so" }])
    expect(ctx.sessionProjections.snapshot(agent.session).values.todos).toBeNull()
  })

  it('releases the command and the gesture fold when the row unloads', async () => {
    const ctx = await loadComposition()
    const agent = agentShowingTheBar(ctx)
    await ctx.commands.execute(agent, PRESS_LINE, [], signal)
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'show-component')
    await row?.fiber?.dispose()

    expect(ctx.commands.list(agent).map(command => command.name)).not.toContain(COMPONENT_ACTION_COMMAND)
    expect(await ctx.commands.execute(agent, PRESS_LINE, [], signal)).toBeUndefined()
    expect(ctx.sessionProjections.snapshot(agent.session).values.componentActions).toBeUndefined()
  })
})
