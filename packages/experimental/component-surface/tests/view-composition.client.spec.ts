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
import { Context } from '@deepseek-ai/cordis'
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

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
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
    '- id: show-component',
    "  name: '@deepseek-ai/dsh-experimental-component-surface'",
    ...config.length === 0 ? [] : ['  config:', ...config],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(world).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
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
      seq: session.events.findIndex(event => event.type === 'content-component/shown'),
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
  it('fails the boot, naming the view and the value inside it', async () => {
    // Loud at load: a view whose spec the tool would refuse is a menu row that
    // shows an empty column when a user clicks it, with nothing anywhere saying
    // why. The Loader carries the sentence out of `apply` and the composition
    // does not come up at all.
    await expect(loadComposition({
      views: [
        '    views:',
        '      - id: site-overview',
        '        title: 站点概览',
        `        spec: ${JSON.stringify({ nodes: [{ id: 'x', component: 'toy.chart', props: {} }] })}`,
      ],
    })).rejects.toThrow(/component-surface: views\[0\] "site-overview" — spec\.nodes\[0\]\.component — names no component/)
  })

  it('fails the boot when homeView names no configured view', async () => {
    await expect(loadComposition({ views: VIEWS_BLOCK, homeView: 'alerts' }))
      .rejects.toThrow('component-surface: homeView "alerts" names no configured view')
  })
})
