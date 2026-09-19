/**
 * REAL-composition coverage for the view that opens the deployment's own data
 * page: a sidebar row a click puts on screen.
 *
 * The command registry, the session store and the content-surface router are
 * all the shipped ones, because what these cases are about is what one click
 * leaves in the log and in the column — and the page is the one block whose
 * placement used to be a question, so the case that matters is that the click
 * alone places it.
 *
 * Every click here is made in a session with no turn open, which is where
 * almost every sidebar click lands: a person picks a row while the agent is
 * idle.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import { COMPONENT_KIND, CRUD_ID } from '../src/component-call.ts'
import * as ShowComponent from '../src/index.ts'
import { SHOW_CONTENT_VIEW_COMMAND } from '../src/view-command.ts'
import { COMPONENT_PLUGIN_NAME, componentPlugin } from './kit-catalog.client.ts'

/** The one view every case here clicks: the deployment's own page for one table. */
const PAGE_NODE = {
  id: 'page',
  component: CRUD_ID as string,
  props: { relatedMeta: 'SpaceLayer', metaLabel: '图层配置', conditions: [{ key: 'status', op: 'EQ', value: 'on' }] },
}
const PAGE_SPEC = { nodes: [PAGE_NODE] }

/** A second view placing no data page, so the two clicks can be compared. */
const PLAIN_SPEC = { nodes: [{ id: 'ball', component: 'el.metric', props: { process: 42, text: '告警' } }] }

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** Boot the console rows this view needs. */
async function loadComposition(): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-crud-view-'))
  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-experimental-content-surface'",
    `- name: '${COMPONENT_PLUGIN_NAME}'`,
    '- id: show-component',
    "  name: '@deepseek-ai/dsh-experimental-component-surface'",
    '  config:',
    '    crud: true',
    '    views:',
    '      - id: layers',
    '        title: 图层数据',
    `        spec: ${JSON.stringify(PAGE_SPEC)}`,
    '      - id: alerts',
    '        title: 告警',
    `        spec: ${JSON.stringify(PLAIN_SPEC)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(world).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    [COMPONENT_PLUGIN_NAME, componentPlugin()],
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
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

/** A fresh session with no turn open, which is where a sidebar click lands. */
function idleSession(ctx: Context): Session {
  return (ctx.get('sessions') as unknown as SessionStore).create()
}

/** A minimal Agent the command runtime can log lifecycle events against. */
function agentOn(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

/** Click one view through the same registry boundary the sidebar's menu uses. */
async function click(ctx: Context, session: Session, line: string): Promise<CommandResult | undefined> {
  const execution = await ctx.commands.execute(
    agentOn(session), `/${SHOW_CONTENT_VIEW_COMMAND} ${line}`, [], new AbortController().signal)
  return execution?.result
}

/** The content entries the session's log folds into. */
function entries(ctx: Context, session: Session): readonly unknown[] {
  return ctx.sessionProjections.snapshot(session).values.contentSurface?.entries ?? []
}

/** Every `content-component/shown` payload the session recorded, in order. */
function shown(session: Session): unknown[] {
  return session.snapshotEvents()
    .filter((event: SessionEvent) => event.type === 'content-component/shown')
    .map((event: SessionEvent) => event.data)
}

describe('a click on a view that opens the data page', () => {
  it('places the page on the click, while the agent is idle and with no question in front of it', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition()
    const session = idleSession(ctx)
    // No text at all: a settlement carrying a sentence is what the chat row
    // draws, and there is nothing to say about a page the user just opened.
    expect(await click(ctx, session, 'layers')).toEqual({ kind: 'success' })
    expect(entries(ctx, session)).toEqual([expect.objectContaining({ kind: COMPONENT_KIND, entryId: 'layers' })])
    // What was opened is reconstructable from the log alone: the entry names
    // the view, and the spec it carries names the table.
    expect(shown(session)).toEqual([{ entryId: 'layers', title: '图层数据', spec: PAGE_SPEC, by: 'user' }])
  })

  it('opens it again on a second click, which is what moves it back to the front of the switcher', async () => {
    const ctx = await loadComposition()
    const session = idleSession(ctx)
    expect(await click(ctx, session, 'layers')).toEqual({ kind: 'success' })
    expect(await click(ctx, session, 'layers')).toEqual({ kind: 'success' })
    expect(shown(session)).toHaveLength(2)
  })

  it('opens a view that places no data page the same way', async () => {
    const ctx = await loadComposition()
    const session = idleSession(ctx)
    expect(await click(ctx, session, 'alerts')).toEqual({ kind: 'success' })
    expect(entries(ctx, session)).toEqual([expect.objectContaining({ entryId: 'alerts' })])
  })

  it('answers a click naming no configured view with one sentence, and opens nothing', async () => {
    const ctx = await loadComposition()
    const session = idleSession(ctx)
    expect(await click(ctx, session, 'gone')).toEqual({ kind: 'error', text: '没有这个视图。' })
    expect(entries(ctx, session)).toEqual([])
  })
})
