/**
 * REAL-composition coverage for the one view that is a question before it is a
 * draw: a sidebar row that opens the deployment's own data page.
 *
 * The sign-on gate, the command registry, the session store and the
 * content-surface router are all the shipped ones, because what these cases are
 * about is what a person is asked and what is remembered of their answer — and
 * the card is read back off the settled command rather than off the builder
 * that wrote it, so the words a person sees and the words a call's card carries
 * cannot change apart.
 *
 * Every click here is made in a session with no turn open, which is where
 * almost every sidebar click lands: a person picks a row while the agent is
 * idle. That is the case the question has to work in.
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
import * as AuthGate from '@deepseek-ai/dsh-experimental-auth-gate'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import { COMPONENT_KIND, CRUD_ID } from '../src/component-call.ts'
import { consentNonce, readConsentQuestion, type ConsentQuestion } from '../src/consent-question.ts'
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

/** A second view placing no data page, for the click that is never a question. */
const PLAIN_SPEC = { nodes: [{ id: 'ball', component: 'el.metric', props: { process: 42, text: '告警' } }] }

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
  /** How long a drawn card stays answerable; the row's own default when omitted. */
  readonly ttlSeconds?: number
}

/** Boot the console rows this view needs. */
async function loadComposition(deployment: Deployment = {}): Promise<Context> {
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
    ...deployment.ttlSeconds === undefined ? [] : [`    crudViewConsentTtlSeconds: ${deployment.ttlSeconds}`],
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

/** Click the data-page view and read the card it was answered with. */
async function ask(ctx: Context, session: Session): Promise<ConsentQuestion> {
  const result = await click(ctx, session, 'layers')
  const question = readConsentQuestion(result?.kind === 'success' ? result.text : undefined)
  if (question === undefined) throw new Error(`expected a question, got ${JSON.stringify(result)}`)
  return question
}

/** Agree to one drawn card, the way the chat row's own button does. */
async function agree(ctx: Context, session: Session, question: ConsentQuestion): Promise<CommandResult | undefined> {
  return await click(ctx, session, `${question.view} ${question.nonce}`)
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
  it('asks while the agent is idle, with the same card a call for that page carries, and draws nothing yet', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const session = idleSession(ctx)
    const question = await ask(ctx, session)
    // Read back off the settled command rather than off the builder: what a
    // person sees and what a call's card carries cannot change apart.
    expect(question.card).toBe(crudApprovalReason(PAGE_NODE as never))
    expect(question.card).toContain('\n数据表：SpaceLayer')
    expect(question.view).toBe('layers')
    expect(entries(ctx, session)).toEqual([])
    expect(shown(session)).toEqual([])
  })

  it('places the page on the click that carries the answer, and records the view and the table', async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const session = idleSession(ctx)
    const question = await ask(ctx, session)
    expect(await agree(ctx, session, question)).toEqual({ kind: 'success' })
    expect(entries(ctx, session)).toEqual([expect.objectContaining({ kind: COMPONENT_KIND, entryId: 'layers' })])
    // What the person agreed to is reconstructable from the log alone: the
    // entry names the view, and the spec it carries names the table.
    expect(shown(session)).toEqual([{ entryId: 'layers', title: '图层数据', spec: PAGE_SPEC, by: 'user' }])
  })

  it('draws nothing for a click that never came back, because a card nobody answered opens nothing', async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const session = idleSession(ctx)
    await ask(ctx, session)
    expect(entries(ctx, session)).toEqual([])
  })

  it('asks once per login, not once per click', async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const first = idleSession(ctx)
    await agree(ctx, first, await ask(ctx, first))
    // A second click, and a click in another session of the same visitor: the
    // answer is the person's, not the conversation's.
    expect(await click(ctx, first, 'layers')).toEqual({ kind: 'success' })
    const second = idleSession(ctx)
    expect(await click(ctx, second, 'layers')).toEqual({ kind: 'success' })
    expect(entries(ctx, second)).toEqual([expect.objectContaining({ entryId: 'layers' })])
  })

  it('asks again after the visitor signs out, and again for a different token', async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const session = idleSession(ctx)
    await agree(ctx, session, await ask(ctx, session))

    await signOut(ctx)
    await ask(ctx, session)

    await signIn(ctx, OTHER_TOKEN)
    await ask(ctx, session)
  })

  it('refuses an answer minted for another login, and asks again', async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const session = idleSession(ctx)
    const question = await ask(ctx, session)
    await signIn(ctx, OTHER_TOKEN)
    const again = readConsentQuestion((await agree(ctx, session, question) as { text?: string }).text)
    expect(again?.nonce).not.toBe(question.nonce)
    expect(entries(ctx, session)).toEqual([])
  })

  it('refuses an answer that was already spent, and asks again', async () => {
    const ctx = await loadComposition({ consent: 'every-time' })
    await signIn(ctx, TOKEN)
    const session = idleSession(ctx)
    const question = await ask(ctx, session)
    expect(await agree(ctx, session, question)).toEqual({ kind: 'success' })
    const again = readConsentQuestion((await agree(ctx, session, question) as { text?: string }).text)
    expect(again?.nonce).not.toBe(question.nonce)
    // One placement, from the click that spent the answer the first time.
    expect(shown(session)).toHaveLength(1)
  })

  it('refuses an answer nobody minted, and asks again', async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const session = idleSession(ctx)
    const forged = { view: 'layers', card: '', nonce: consentNonce('0'.repeat(32)) }
    const asked = readConsentQuestion((await agree(ctx, session, forged) as { text?: string }).text)
    expect(asked?.view).toBe('layers')
    expect(entries(ctx, session)).toEqual([])
  })

  it('refuses an answer the deadline has passed, and asks again', async () => {
    // One second is the shortest deadline the schema admits, which is what
    // makes this the whole of the wait.
    const ctx = await loadComposition({ ttlSeconds: 1 })
    await signIn(ctx, TOKEN)
    const session = idleSession(ctx)
    const question = await ask(ctx, session)
    await new Promise(resolve => setTimeout(resolve, 1100))
    const again = readConsentQuestion((await agree(ctx, session, question) as { text?: string }).text)
    expect(again?.nonce).not.toBe(question.nonce)
    expect(entries(ctx, session)).toEqual([])
  })

  it('asks on every click where the deployment says so', async () => {
    const ctx = await loadComposition({ consent: 'every-time' })
    await signIn(ctx, TOKEN)
    const session = idleSession(ctx)
    await agree(ctx, session, await ask(ctx, session))
    // The answer stood for the click that carried it and for nothing after it.
    await ask(ctx, session)
    expect(shown(session)).toHaveLength(1)
  })

  it('asks every time where there is no login to remember an answer under, and still opens on the answer', async () => {
    const ctx = await loadComposition({ gate: false })
    const session = idleSession(ctx)
    const question = await ask(ctx, session)
    expect(await agree(ctx, session, question)).toEqual({ kind: 'success' })
    // Bound to the conversation rather than to a person, so nothing outlives
    // the click that carried it.
    await ask(ctx, session)
    expect(shown(session)).toHaveLength(1)
  })

  it('refuses an answer minted in another session where there is no login', async () => {
    const ctx = await loadComposition({ gate: false })
    const first = idleSession(ctx)
    const question = await ask(ctx, first)
    const second = idleSession(ctx)
    const again = readConsentQuestion((await agree(ctx, second, question) as { text?: string }).text)
    expect(again?.nonce).not.toBe(question.nonce)
    expect(entries(ctx, second)).toEqual([])
  })

  it('places a view that opens no data page on the first click, with no question at all', async () => {
    const ctx = await loadComposition()
    await signIn(ctx, TOKEN)
    const session = idleSession(ctx)
    expect(await click(ctx, session, 'alerts')).toEqual({ kind: 'success' })
    expect(entries(ctx, session)).toEqual([expect.objectContaining({ entryId: 'alerts' })])
  })
})
