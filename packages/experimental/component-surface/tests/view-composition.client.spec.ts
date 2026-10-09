/**
 * REAL-composition coverage for the vendor-view half: a test-only cordis.yml
 * booted through the vendored Loader mounts the webserver, the command
 * registry, the session store, the projection registry and the content-surface
 * router, and every assertion observes what the composed application does —
 * the catalog the sidebar reads off HTTP, the durable record a click leaves,
 * the entry that record folds into, and the release of both registrations on
 * fiber disposal (HMR safety).
 *
 * The load-time failures are asserted against the same Loader rather than
 * against `indexViews` directly (`views.client.spec.ts` owns that): what a
 * deployment gets for a broken `views` block is a row that does not come up,
 * and only the composed boot can show that.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Logger } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import { COMPONENT_KIND } from '../src/component-call.ts'
import { COMPONENT_VIEWS_ROUTE } from '../src/route.ts'
import { SHOW_CONTENT_VIEW_COMMAND } from '../src/view-command.ts'
import * as ShowComponent from '../src/index.ts'
import { COMPONENT_PLUGIN_NAME, componentPlugin } from './kit-catalog.client.ts'

/**
 * The configured view the whole file is written against: a table above the
 * details of whatever row is picked, which is the arrangement a deployment
 * actually writes and the one that exercises `layout` and `$from` together.
 */
const OVERVIEW = {
  nodes: [
    {
      id: 'sites',
      component: 'toy.table',
      props: {
        selectMode: 'radio',
        tableConfig: { gridItems: [{ relatedMetaAttr: 'name', alias: '站点' }] },
        displayValueList: [{ name: '一号站点' }, { name: '二号站点' }],
      },
    },
    {
      id: 'detail',
      component: 'toy.record',
      props: { dataList: { $from: 'node:sites.selectionDetail' }, columnNum: 1 },
    },
  ],
  layout: {
    node: 'stack',
    dir: 'col',
    gap: 'md',
    children: [{ node: 'component', id: 'sites', flex: 2 }, { node: 'component', id: 'detail', flex: 1 }],
  },
}

/** The `views` block, as `cordis.yml` carries it: one line of YAML per value. */
const VIEWS_BLOCK = [
  '    views:',
  '      - id: site-overview',
  '        title: 站点概览',
  `        spec: ${JSON.stringify(OVERVIEW)}`,
]

let world: string | undefined
let context: Context | undefined

/** Every error record the booted composition logged, as `[logger name] text`. */
let errorLog: string[] = []

/** The clause the row's own refusal line carries and no other record does. */
const CONSEQUENCE = 'this deployment comes up with no components, no views and no show_component tool '
  + 'until that view is corrected or removed'

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  errorLog = []
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** The row's own config lines, appended under `config:`. */
interface Deployment {
  /** Lines of the `views` block; omit for a deployment that configures none. */
  views?: string[]
  /** The `homeView` value, when the deployment names one. */
  homeView?: string
}

/** Write a cordis.yml for one deployment and boot it through the real Loader. */
async function loadComposition(deployment: Deployment = { views: VIEWS_BLOCK }): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-component-views-'))
  const configPath = join(world, 'cordis.yml')
  const config = [...deployment.views ?? [], ...deployment.homeView === undefined ? [] : [`    homeView: ${deployment.homeView}`]]
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
    ...config.length === 0 ? [] : ['  config:', ...config],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  // The sink a console exporter is: what a row logs while booting is what an
  // operator reads, so the assertions are made on the rendered text.
  ctx.logger.exporter({
    export: (message) => {
      if (message.type === 'error') errorLog.push(`[${message.name}] ${Logger.format({ export() {} }, message)}`)
    },
  })
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
  // Loader settlement does not reject a failed plugin; each fiber's own await rethrows it.
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

/**
 * A fresh session from the host store. Reached through `ctx.get` and cast: this
 * package compiles in the Client aggregate, where the cordis `Context.sessions`
 * merge names the browser service rather than the host store.
 * @param ctx - the booted composition.
 * @returns a new session.
 */
function newSession(ctx: Context): Session {
  return (ctx.get('sessions') as unknown as SessionStore).create()
}

/** A minimal Agent the command runtime can log lifecycle events against. */
function agentOn(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

/** Click one view through the same registry boundary the sidebar's menu uses. */
async function click(ctx: Context, agent: Agent, id: string): Promise<unknown> {
  const execution = await ctx.commands.execute(agent, `/${SHOW_CONTENT_VIEW_COMMAND} ${id}`, [], new AbortController().signal)
  return execution?.result
}

/** GET the catalog route against the running server. */
async function readCatalog(ctx: Context): Promise<{ status: number; type: string | null; cacheControl: string | null; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${COMPONENT_VIEWS_ROUTE}`)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    body: await response.json(),
  }
}

describe('the view catalog route', () => {
  it('serves the id and title of every configured view, and the home view beside them', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition({ views: VIEWS_BLOCK, homeView: 'site-overview' })
    expect(await readCatalog(ctx)).toEqual({
      status: 200,
      type: 'application/json',
      // The sidebar reads this once per boot off the row it booted with, so a
      // cached copy would outlive its own truth.
      cacheControl: 'no-store',
      body: { views: [{ id: 'site-overview', title: '站点概览' }], homeView: 'site-overview' },
    })
  })

  it('leaves homeView out entirely when the deployment configures none', async () => {
    expect((await readCatalog(await loadComposition())).body).toEqual({ views: [{ id: 'site-overview', title: '站点概览' }] })
  })

  it('never serves a spec: what a click puts in the column comes from the host, not from the page', async () => {
    const catalog = (await readCatalog(await loadComposition())).body as { views: Record<string, unknown>[] }
    expect(Object.keys(catalog.views[0] ?? {})).toEqual(['id', 'title'])
  })

  it('refuses a write with the complete set of methods it does answer', async () => {
    const ctx = await loadComposition()
    const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${COMPONENT_VIEWS_ROUTE}`, { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
  })

  it('claims neither the route nor the command where the deployment configures no views', async () => {
    const ctx = await loadComposition({})
    // The SPA fallback answers an unclaimed path, so the sidebar's read of an
    // absent catalog fails the same way it does where this row is not composed
    // at all — which is the case it already contains.
    expect((await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${COMPONENT_VIEWS_ROUTE}`)).status).not.toBe(200)
    expect(ctx.commands.find(agentOn(newSession(ctx)), SHOW_CONTENT_VIEW_COMMAND)).toBeUndefined()
    // Everything the agent's own half contributes is still there: views are an
    // addition to this row, not a condition of it.
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('show_component')
  })

  it('releases the route and the command when the row unloads (HMR safety)', async () => {
    const ctx = await loadComposition()
    const port = ctx.webServer.port
    const agent = agentOn(newSession(ctx))
    await [...ctx.loader.entries()].find(entry => entry.options.id === 'show-component')?.fiber?.dispose()
    expect((await fetch(`http://127.0.0.1:${String(port)}${COMPONENT_VIEWS_ROUTE}`)).status).not.toBe(200)
    expect(ctx.commands.find(agent, SHOW_CONTENT_VIEW_COMMAND)).toBeUndefined()
  })
})

describe('a click on a configured view', () => {
  it('puts the view in the column, folded out of the event the click wrote', async () => {
    const ctx = await loadComposition()
    const session = newSession(ctx)
    expect(await click(ctx, agentOn(session), 'site-overview')).toEqual({ kind: 'success' })
    const entries = ctx.sessionProjections.snapshot(session).values.contentSurface?.entries
    expect(entries).toEqual([{
      kind: COMPONENT_KIND,
      entryId: 'site-overview',
      // The entry is dated by the event the click wrote, which sits between the
      // command runtime's own two records.
      seq: session.snapshotEvents().findIndex(event => event.type === 'content-component/shown'),
      title: '站点概览',
      // The spec the seat draws, `layout` and `$from` included, exactly as
      // load-time validation accepted it.
      payload: { spec: OVERVIEW },
    }])
  })

  it('moves the same entry back to the front on a second click, rather than adding a second one', async () => {
    const ctx = await loadComposition()
    const session = newSession(ctx)
    const agent = agentOn(session)
    await click(ctx, agent, 'site-overview')
    const first = ctx.sessionProjections.snapshot(session).values.contentSurface?.entries ?? []
    await click(ctx, agent, 'site-overview')
    const second = ctx.sessionProjections.snapshot(session).values.contentSurface?.entries ?? []
    expect(second).toHaveLength(first.length)
    expect(second[0]?.entryId).toBe('site-overview')
    expect(second[0]?.seq).toBeGreaterThan(first[0]?.seq ?? 0)
  })

  it('answers a view the deployment does not configure with one sentence and no entry', async () => {
    const ctx = await loadComposition()
    const session = newSession(ctx)
    expect(await click(ctx, agentOn(session), 'alerts')).toEqual({ kind: 'error', text: '没有这个视图。' })
    expect(ctx.sessionProjections.snapshot(session).values.contentSurface?.entries).toEqual([])
  })
})

describe('a deployment whose views the tool would refuse', () => {
  it('refuses the contribution that completes the catalog, and offers nothing', async () => {
    // A view whose spec the tool would refuse is a menu row that shows an empty
    // column when a user clicks it, so the row refuses it rather than
    // publishing it. Which components exist is another row's contribution, so
    // the refusal lands where the catalog was completed: that contribution is
    // taken back out, the component row carries the sentence, and the
    // deployment comes up with no components and no tool at all rather than
    // with a menu row nothing can draw.
    const ctx = await loadComposition({
      views: [
        '    views:',
        '      - id: site-overview',
        '        title: 站点概览',
        `        spec: ${JSON.stringify({ nodes: [{ id: 'x', component: 'toy.chart', props: {} }] })}`,
      ],
    })
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('show_component')
    expect((await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${COMPONENT_VIEWS_ROUTE}`)).status).not.toBe(200)
  })

  it('says so in the process log, naming the view, the whole refusal and what it cost', async () => {
    // Everything else about this failure is an absence — no tool, no route, no
    // view — and the refusal itself travels to the registration that completed
    // the catalog. This line is the only one that tells an operator which view
    // is wrong and what the deployment lost for it; cordis logs the same
    // rejection again under the same row with a stack and no consequence,
    // which is why the assertion is on the row's own sentence.
    await loadComposition({
      views: [
        '    views:',
        '      - id: site-overview',
        '        title: 站点概览',
        `        spec: ${JSON.stringify({ nodes: [{ id: 'x', component: 'toy.chart', props: {} }] })}`,
      ],
    })
    const told = errorLog.filter(line => line.includes(CONSEQUENCE))
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('[show-component] ')
    expect(told[0]).toContain('component-surface: views[0] "site-overview" — spec.nodes[0].component')
    expect(told[0]).toContain('names no component of this deployment. Available components:')
  })

  it('says so for a view writing a key named __proto__, at that key', async () => {
    // The YAML reader keeps the key as one more key of the mapping, and the
    // config schema hands the spec over as written, so the judgement meets it.
    await loadComposition({
      views: [
        '    views:',
        '      - id: site-overview',
        '        title: 站点概览',
        '        spec:',
        '          nodes:',
        '            - id: facts',
        '              component: toy.record',
        '              props:',
        '                dataList: [{ label: 编号, display: A-1 }]',
        '                __proto__: { columnNum: 2 }',
      ],
    })
    const told = errorLog.filter(line => line.includes(CONSEQUENCE))
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('component-surface: views[0] "site-overview" — spec.nodes[0].props.__proto__ — is a key named __proto__, '
      + 'which no mapping of a view may carry')
  })

  it('refuses a homeView naming no configured view the same way', async () => {
    const ctx = await loadComposition({ views: VIEWS_BLOCK, homeView: 'alerts' })
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('show_component')
    const told = errorLog.filter(line => line.includes(CONSEQUENCE))
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('component-surface: homeView "alerts" names no configured view')
  })
})
