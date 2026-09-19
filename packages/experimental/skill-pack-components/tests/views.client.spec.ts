/**
 * REAL-composition coverage for the other direction: a pack's views reach the
 * sidebar's catalog and the command that shows one, and a view the component
 * surface will not draw holds its pack back instead of failing anything.
 *
 * Everything is the shipped path — the Loader, the component catalog, the pack
 * root's provider, the web server, the command registry and the content
 * surface — because what these cases are about is the wiring between them.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import * as ShowComponent from '@deepseek-ai/dsh-experimental-component-surface'
import { COMPONENT_KIT_ENTRIES } from '@deepseek-ai/dsh-experimental-component-surface'
import SkillPackRegistry from '@deepseek-ai/dsh-experimental-skill-pack'
import type { PackStatus } from '@deepseek-ai/dsh-experimental-skill-pack'
import * as SkillPackComponents from '../src/index.ts'

const PLATFORM_VERSION = '0.5.2'
const KIT = '@deepseek-ai/dsh-experimental-component-kit'
const COMPONENT_PLUGIN_NAME = 'test:component-plugin'

/** The route the sidebar's navigation menu is built from. */
const VIEWS_ROUTE = '/component-surface/views'

/** The command a click on one of its rows runs. */
const SHOW_CONTENT_VIEW = 'show-content-view'

/** A component plugin contributing the shipped components and nothing else. */
function componentPlugin(): { name: string; inject: readonly string[]; apply: (ctx: Context) => void } {
  return {
    name: 'test-component-plugin',
    inject: ['componentCatalog'],
    apply(ctx: Context) {
      ctx.componentCatalog.register({ entries: COMPONENT_KIT_ENTRIES, source: { package: KIT, version: '0.4.0' } })
    },
  }
}

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** One pack, as a delivery writes it: a SKILL.md carrying the manifest, and the view files it declares. */
async function writePack(root: string, name: string, views: Record<string, string>): Promise<void> {
  const directory = join(root, name)
  await mkdir(join(directory, 'views'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} description.`,
    'metadata:',
    '  pack:',
    '    version: 1.0.0',
    '  requires:',
    '    components:',
    `      "${KIT}": ">=0.4.0"`,
    '    parts: [toy.record]',
    `  views: [${Object.keys(views).map(file => `views/${file}`).join(', ')}]`,
    '---',
    `Instructions for ${name}.`,
    '',
  ].join('\n'))
  for (const [file, body] of Object.entries(views)) await writeFile(join(directory, 'views', file), body)
}

/** A view file that draws one record row, with the value taken from a param. */
function recordView(id: string, title: string, display: string): string {
  return [
    `id: ${id}`,
    `title: ${title}`,
    'spec:',
    '  nodes:',
    '    - id: facts',
    '      component: toy.record',
    '      props:',
    '        dataList:',
    '          - label: 表',
    '            display: { $param: meta }',
    'params:',
    `  meta: ${display}`,
    '',
  ].join('\n')
}

/** What one booted deployment holds. */
interface Deployment {
  /** The packs in the root, each with its view files. */
  readonly packs: Record<string, Record<string, string>>
  /** The `views` block of the deployment's own configuration, as cordis.yml lines. */
  readonly configured?: readonly string[]
  /** The view ids this deployment ends up offering, which the boot is awaited against. */
  readonly offered: readonly string[]
}

/** Boot the whole path over a freshly written pack root. */
async function loadComposition(deployment: Deployment): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-pack-views-'))
  const root = join(world, 'packs')
  await mkdir(root, { recursive: true })
  for (const [name, views] of Object.entries(deployment.packs)) await writePack(root, name, views)

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
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@deepseek-ai/dsh-experimental-content-surface'",
    `- name: '${COMPONENT_PLUGIN_NAME}'`,
    '- id: show-component',
    "  name: '@deepseek-ai/dsh-experimental-component-surface'",
    ...deployment.configured ?? [],
    '- id: skill-pack',
    "  name: '@deepseek-ai/dsh-experimental-skill-pack'",
    '  config:',
    `    root: ${JSON.stringify(root)}`,
    `    platformVersion: '${PLATFORM_VERSION}'`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-experimental-skill-pack-components'",
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
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@deepseek-ai/dsh-experimental-content-surface', ContentSurfaceRegistry],
    ['@deepseek-ai/dsh-experimental-component-surface', ShowComponent],
    ['@deepseek-ai/dsh-experimental-skill-pack', SkillPackRegistry],
    ['@deepseek-ai/dsh-experimental-skill-pack-components', SkillPackComponents],
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
  await settle(ctx, deployment.offered)
  return ctx
}

/**
 * Wait until the view index holds exactly these ids.
 *
 * A pack root is read from disk, so a pack's views reach the index after the
 * boot settles — and `statuses()` answering the judgement is not that moment,
 * because the registration the catalog route and the `show-content-view`
 * command are built from follows it. The wait is therefore on the index
 * itself, through the change the registry publishes, and it is what the case
 * that clicks a view depends on: the command exists only while the index
 * holds something, so a case that clicked before the offer landed found no
 * command and was answered with nothing at all.
 * @param ctx - the booted composition.
 * @param offered - the view ids the deployment offers once it has settled, in any order.
 * @throws {Error} when the index still holds something else after 20 seconds.
 */
async function settle(ctx: Context, offered: readonly string[]): Promise<void> {
  await ctx.skillPacks.statuses()
  const wanted = [...offered].sort().join(',')
  const held = (): string => [...ctx.componentViews.index.keys()].sort().join(',')
  if (held() === wanted) return
  let stop: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(`the view index holds "${held()}" while this case waits for "${wanted}"`)) }, 20_000)
      stop = ctx.componentViews.onChange(() => { if (held() === wanted) resolve() })
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Stopped after the promise settles rather than inside the handler, so the
    // registry is never asked to drop a subscription while it is dispatching.
    stop?.()
  }
}

/** The catalog the sidebar reads. */
async function readCatalog(ctx: Context): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${VIEWS_ROUTE}`)
  return { status: response.status, body: response.status === 200 ? await response.json() : undefined }
}

/** One pack's status, as the pack root's provider judges it now. */
async function statusOf(ctx: Context, skill: string): Promise<PackStatus | undefined> {
  return (await ctx.skillPacks.statuses()).find(status => status.skill === skill)
}

/** A fresh session from the host store. */
function newSession(ctx: Context): Session {
  return (ctx.get('sessions') as unknown as SessionStore).create()
}

/** A minimal Agent the command runtime can log lifecycle events against. */
function agentOn(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

/** Click one view through the registry boundary the sidebar's menu uses. */
async function click(ctx: Context, agent: Agent, id: string): Promise<unknown> {
  const execution = await ctx.commands.execute(agent, `/${SHOW_CONTENT_VIEW} ${id}`, [], new AbortController().signal)
  return execution?.result
}

describe('a pack\'s views', () => {
  it('reach the sidebar\'s catalog, with their params already in them', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition({ offered: ['layers'], packs: { 'space-data-page': { 'layers.yml': recordView('layers', '图层数据', 'sys_layer') } } })
    expect(await statusOf(ctx, 'space-data-page')).toEqual({
      skill: 'space-data-page',
      version: '1.0.0',
      state: 'active',
      missing: [],
    })
    expect(await readCatalog(ctx)).toEqual({ status: 200, body: { views: [{ id: 'layers', title: '图层数据' }] } })
  })

  it('are shown by the same command a configured view is', async () => {
    const ctx = await loadComposition({ offered: ['layers'], packs: { 'space-data-page': { 'layers.yml': recordView('layers', '图层数据', 'sys_layer') } } })
    const session = newSession(ctx)
    expect(await click(ctx, agentOn(session), 'layers')).toEqual({ kind: 'success' })
    expect(ctx.sessionProjections.snapshot(session).values.contentSurface?.entries).toEqual([{
      kind: 'component',
      entryId: 'layers',
      seq: session.snapshotEvents().findIndex(event => event.type === 'content-component/shown'),
      title: '图层数据',
      // The param the pack declared, substituted when the view was read.
      payload: { spec: { nodes: [{ id: 'facts', component: 'toy.record', props: { dataList: [{ label: '表', display: 'sys_layer' }] } }] } },
    }])
  })

  it('appear beside the deployment\'s own, which keep an id they both claim', async () => {
    const configured = [
      '  config:',
      '    views:',
      '      - id: layers',
      '        title: 部署自己的图层',
      '        spec: {"nodes":[{"id":"facts","component":"toy.record","props":{"dataList":[{"label":"表","display":"own"}]}}]}',
    ]
    const ctx = await loadComposition({
      offered: ['layers', 'sites'],
      configured,
      packs: {
        'space-data-page': { 'layers.yml': recordView('layers', '图层数据', 'sys_layer') },
        'other-pack': { 'sites.yml': recordView('sites', '站点', 'sys_site') },
      },
    })
    expect((await readCatalog(ctx)).body).toEqual({ views: [{ id: 'layers', title: '部署自己的图层' }, { id: 'sites', title: '站点' }] })
    // The pack that claimed a taken id is offered to nobody rather than losing
    // one view: a skill whose page is missing is worse than no skill.
    expect(await statusOf(ctx, 'space-data-page')).toEqual({
      skill: 'space-data-page',
      version: '1.0.0',
      state: 'inactive',
      missing: [{
        kind: 'view-refused',
        view: 'views/layers.yml',
        path: 'id',
        reason: 'the view id "layers" is already offered by this deployment',
      }],
    })
    expect((await ctx.skills.list()).map(candidate => candidate.name)).not.toContain('space-data-page')
  })

  it('hold their pack back when the component surface will not draw one of them', async () => {
    const ctx = await loadComposition({
      offered: [],
      packs: {
        'space-data-page': {
          'layers.yml': recordView('layers', '图层数据', 'sys_layer'),
          'chart.yml': 'id: chart\ntitle: 图表\nspec:\n  nodes:\n    - id: x\n      component: toy.chart\n      props: {}\n',
        },
      },
    })
    const status = await statusOf(ctx, 'space-data-page')
    expect(status?.state).toBe('inactive')
    const [missing] = status?.missing ?? []
    expect(missing?.kind).toBe('view-refused')
    expect(missing).toMatchObject({ view: 'views/chart.yml', path: 'spec.nodes[0].component' })
    expect(missing?.kind === 'view-refused' ? missing.reason : '')
      .toContain('spec.nodes[0].component — names no component of this deployment')
    // Nothing of the pack is offered: not the skill, and not the view that read
    // cleanly either.
    expect((await ctx.skills.list()).map(candidate => candidate.name)).not.toContain('space-data-page')
    expect((await readCatalog(ctx)).status).not.toBe(200)
  })

  it('leave with the component plugin that made them drawable, with no restart', async () => {
    const ctx = await loadComposition({ offered: ['layers'], packs: { 'space-data-page': { 'layers.yml': recordView('layers', '图层数据', 'sys_layer') } } })
    expect((await readCatalog(ctx)).status).toBe(200)
    await [...ctx.loader.entries()].find(entry => entry.options.name === COMPONENT_PLUGIN_NAME)?.fiber?.dispose()
    await settle(ctx, [])
    expect((await statusOf(ctx, 'space-data-page'))?.state).toBe('inactive')
    expect((await readCatalog(ctx)).status).not.toBe(200)
  })

  it('leave with this row (HMR safety)', async () => {
    const ctx = await loadComposition({ offered: ['layers'], packs: { 'space-data-page': { 'layers.yml': recordView('layers', '图层数据', 'sys_layer') } } })
    expect((await readCatalog(ctx)).status).toBe(200)
    await [...ctx.loader.entries()]
      .find(entry => entry.options.name === '@deepseek-ai/dsh-experimental-skill-pack-components')?.fiber?.dispose()
    await settle(ctx, [])
    expect((await readCatalog(ctx)).status).not.toBe(200)
  })
})
