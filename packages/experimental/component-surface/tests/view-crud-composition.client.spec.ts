/**
 * REAL-composition coverage for the one view that is a question before it is a
 * draw: a sidebar row that opens the deployment's own data page.
 *
 * The approval service, the sign-on gate, the command registry, the session
 * store and the content-surface router are all the shipped ones, because what
 * these cases are about is what a person is asked and what is remembered of
 * their answer — and the card is read back off the real `approval/asked` record
 * rather than off the builder that wrote it, so the words a person sees and the
 * words a call's card carries cannot change apart.
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
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as AuthGate from '@deepseek-ai/dsh-experimental-auth-gate'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import { COMPONENT_KIND, CRUD_ID } from '../src/component-call.ts'
import { crudApprovalReason } from '../src/crud.ts'
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

/** Two JWT-shaped tokens: one visitor signing in, and a different login. */
const TOKEN = 'aaa.bbb.ccc'
const OTHER_TOKEN = 'ddd.eee.fff'

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** What one booted deployment holds. */
interface Deployment {
  /** How long an answer stands; the row's own default when omitted. */
  readonly consent?: 'per-login' | 'every-time'
  /** Whether the sign-on gate is composed at all. */
  readonly gate?: boolean
  /** Whether an approval answerer is composed; without one every question fails closed. */
  readonly answerer?: boolean
  /** Whether the approval service is composed at all. */
  readonly approval?: boolean
}

/** Every question the composed answerer was asked, in order. */
let asked: string[] = []

/** What the composed answerer says next. */
let answer: ApprovalOutcome = 'allowed-once'

/** Boot the console rows this view needs. */
async function loadComposition(deployment: Deployment = {}): Promise<Context> {
  asked = []
  answer = 'allowed-once'
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
    ...deployment.approval === false ? [] : ["- name: '@deepseek-ai/dsh-user-approval'"],
    ...deployment.gate === false ? [] : [
      "- name: '@deepseek-ai/dsh-experimental-auth-gate'",
      '  config:',
      "    loginUrl: '/sign-in/'",
      '    cookieName: dsh_token',
      '    refreshMarginSeconds: 60',
      '    mcpUpstreams: {}',
    ],
    `- name: '${COMPONENT_PLUGIN_NAME}'`,
    '- id: show-component',
    "  name: '@deepseek-ai/dsh-experimental-component-surface'",
    '  config:',
    '    crud: true',
    `    crudViewConsent: ${deployment.consent ?? 'per-login'}`,
    '    views:',
    '      - id: layers',
    '        title: 图层数据',
    `        spec: ${JSON.stringify(PAGE_SPEC)}`,
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
    ['@deepseek-ai/dsh-user-approval', UserApproval],
    ['@deepseek-ai/dsh-experimental-auth-gate', AuthGate],
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
  if (deployment.answerer !== false) {
    ctx.on('approval/request', (request) => {
      asked.push(request.reason ?? '')
      return Promise.resolve(answer)
    })
  }
  return ctx
}

/** A fresh session with a turn open, which is where a click made mid-answer lands. */
function sessionInTurn(ctx: Context): Session {
  const session = (ctx.get('sessions') as unknown as SessionStore).create()
  session.append('turn/start', { turn: 1 })
  return session
}

/** A minimal Agent the command runtime can log lifecycle events against. */
function agentOn(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

/** Click the view through the same registry boundary the sidebar's menu uses. */
async function click(ctx: Context, session: Session): Promise<unknown> {
  const execution = await ctx.commands.execute(
    agentOn(session), `/${SHOW_CONTENT_VIEW_COMMAND} layers`, [], new AbortController().signal)
  return execution?.result
}

/** The content entries the session's log folds into. */
function entries(ctx: Context, session: Session): readonly unknown[] {
  return ctx.sessionProjections.snapshot(session).values.contentSurface?.entries ?? []
}

/** Post one token to the gate, the way the browser half does. */
async function signIn(ctx: Context, token: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/auth-gate/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  expect(response.status).toBe(204)
}

/** Sign the visitor out through the route the browser half uses. */
async function signOut(ctx: Context): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/auth-gate/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  expect(response.status).toBe(204)
}

describe('a click on a view that opens the data page', () => {
  it('asks the user the same question a call for that page asks, before anything is drawn', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const session = sessionInTurn(ctx)
    expect(await click(ctx, session)).toEqual({ kind: 'success' })
    // Read back off the real audit record rather than off the builder: what a
    // person sees and what a call's card carries cannot change apart.
    const card = session.snapshotEvents()
      .filter((event: SessionEvent) => event.type === 'approval/asked')
      .map(event => event.data.reason)
    expect(card).toEqual([crudApprovalReason(PAGE_NODE as never)])
    expect(card[0]).toContain('\n数据表：SpaceLayer')
    expect(entries(ctx, session)).toEqual([expect.objectContaining({ kind: COMPONENT_KIND, entryId: 'layers' })])
  })

  it('draws nothing and says so when the user does not open it', async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const session = sessionInTurn(ctx)
    answer = 'rejected'
    expect(await click(ctx, session)).toEqual({ kind: 'error', text: '没有打开。' })
    expect(entries(ctx, session)).toEqual([])
    expect(session.snapshotEvents().some(event => event.type === 'content-component/shown')).toBe(false)
  })

  it('asks once per login, not once per click', async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const first = sessionInTurn(ctx)
    await click(ctx, first)
    // A second click, and a click in another session of the same visitor: the
    // answer is the person's, not the conversation's.
    await click(ctx, first)
    const second = sessionInTurn(ctx)
    expect(await click(ctx, second)).toEqual({ kind: 'success' })
    expect(asked).toHaveLength(1)
    expect(entries(ctx, second)).toEqual([expect.objectContaining({ entryId: 'layers' })])
  })

  it('asks again after the visitor signs out, and again for a different token', async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    await click(ctx, sessionInTurn(ctx))
    expect(asked).toHaveLength(1)

    await signOut(ctx)
    await click(ctx, sessionInTurn(ctx))
    expect(asked).toHaveLength(2)

    await signIn(ctx, OTHER_TOKEN)
    await click(ctx, sessionInTurn(ctx))
    expect(asked).toHaveLength(3)
  })

  it('asks on every click where the deployment says so', async () => {
    const ctx = await loadComposition({ consent: 'every-time' })
    await signIn(ctx, TOKEN)
    const session = sessionInTurn(ctx)
    await click(ctx, session)
    await click(ctx, session)
    expect(asked).toHaveLength(2)
  })

  it('asks every time where there is no login to remember an answer under', async () => {
    const ctx = await loadComposition({ gate: false })
    const session = sessionInTurn(ctx)
    await click(ctx, session)
    await click(ctx, session)
    expect(asked).toHaveLength(2)
  })

  it('draws nothing where the deployment composed no approval service', async () => {
    // A page nobody can be asked about is one nobody may open, which is the
    // rule the tool already applies to its own offer.
    const ctx = await loadComposition({ approval: false })
    await signIn(ctx, TOKEN)
    const session = sessionInTurn(ctx)
    expect(await click(ctx, session)).toEqual({ kind: 'error', text: '没有打开。' })
    expect(entries(ctx, session)).toEqual([])
  })

  it('draws nothing where the question reached no answerer', async () => {
    const ctx = await loadComposition({ answerer: false })
    await signIn(ctx, TOKEN)
    const session = sessionInTurn(ctx)
    expect(await click(ctx, session)).toEqual({ kind: 'error', text: '没有打开。' })
    expect(entries(ctx, session)).toEqual([])
  })

  it('draws nothing where the question could not be put at all, and asks nobody', async () => {
    // A command handler runs wherever the user clicked, and the approval
    // service refuses to ask between turns: its audit pair has to be enclosed
    // by one. The click is answered the way a refusal is.
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const session = (ctx.get('sessions') as unknown as SessionStore).create()
    expect(await click(ctx, session)).toEqual({ kind: 'error', text: '没有打开。' })
    expect(asked).toEqual([])
    expect(entries(ctx, session)).toEqual([])
  })
})
