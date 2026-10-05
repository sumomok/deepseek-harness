/**
 * REAL-composition coverage for taking render reports per console member: a
 * test-only cordis.yml booted through the vendored Loader mounts the
 * webserver, the tool runtime, the session store and projection registry, the
 * show-chart row with `perMember`, and — where a case needs one — the
 * test-only `consoleMembers` row from `fixtures/console-members.client.ts`.
 * Every assertion observes the served report route, the `show_chart` results,
 * and what the composition logged.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Logger } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ShowChart from '../src/index.ts'
import { reportDirectoryMismatch } from '../src/members.ts'
import { PendingCharts } from '../src/pending.ts'
import { SHOW_CHART_REPORT_ROUTE } from '../src/route.ts'
import { MEMBER_HEADER, type Config as FixtureConfig } from './fixtures/console-members.client.ts'

const MEMBERS_ROW = pathToFileURL(resolve(import.meta.dirname, 'fixtures/console-members.client.ts')).href

const MEMBER_A = 'member-a-key'
const MEMBER_B = 'member-b-key'
/** What each member's requests carry in place of the signed member assertion. */
const ASSERTION_A = 'assertion-of-a'
const ASSERTION_B = 'assertion-of-b'
const ASSERTION_NOBODY = 'assertion-of-nobody'

/** The directory's tables: two members, their sessions, and a child of A's. */
const MEMBERS: FixtureConfig = {
  requests: { [ASSERTION_A]: MEMBER_A, [ASSERTION_B]: MEMBER_B },
  sessions: { 'session-a': MEMBER_A, 'session-b': MEMBER_B },
  parents: { 'session-a-child': 'session-a' },
}

/** The call ids the cases open; none may reach an answer body or a log line. */
const CALL_A = 'chart-call-of-member-a'
const CALL_CHILD = 'chart-call-of-a-child-session'
const CALL_NO_AGENT = 'chart-call-outside-any-agent'

/** Every value no response body and no log line may carry. */
const SECRETS = [MEMBER_A, MEMBER_B, ASSERTION_A, ASSERTION_B, ASSERTION_NOBODY, CALL_A, CALL_CHILD, CALL_NO_AGENT]

/** The verdict each member's console posts. */
const PAINTED = { ok: true, seriesCount: 1, pointCount: 2 }
const FORGED = { ok: false, error: 'forged by another member' }

/** What a report no call takes is answered with, as it crosses the wire. */
const REFUSED_BODY = '{"accepted":false}'

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** One log line, as the root exporter received it. */
interface LogLine {
  name: string
  type: string
  text: string
}

/** A booted composition and everything its rows logged. */
interface Composition {
  ctx: Context
  logs: LogLine[]
}

/**
 * Write a test-only cordis.yml and boot it through the real Loader.
 * @param options - the row's `perMember` (absent leaves the field out), and the
 * directory row's tables (absent leaves the row out).
 * @returns the booted context and its log.
 */
async function loadComposition(options: { perMember?: boolean; members?: FixtureConfig }): Promise<Composition> {
  world = await mkdtemp(join(tmpdir(), 'dsh-show-chart-members-'))
  const configPath = join(world, 'cordis.yml')
  const rows: unknown[] = [
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-session' },
    { name: '@deepseek-ai/dsh-session-projection' },
    {
      id: 'show-chart',
      name: '@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc',
      config: { verdictTimeoutMs: 5000, ...options.perMember === undefined ? {} : { perMember: options.perMember } },
    },
    ...options.members === undefined ? [] : [{ id: 'console-members', name: MEMBERS_ROW, config: options.members }],
  ]
  // JSON is YAML, so the rows are written as the documents they are.
  await writeFile(configPath, `${JSON.stringify(rows, null, 2)}\n`)

  const logs: LogLine[] = []
  const ctx = context = new Context()
  ctx.logger.exporter({
    export: (message) => { logs.push({ name: message.name, type: message.type, text: Logger.format({ export() {} }, message) }) },
  })
  ctx.baseUrl = pathToFileURL(world).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Without a Node internal loader the Loader imports bare names through this
  // test runner's module graph, which resolves workspace packages to `src`.
  ctx.loader.internal = undefined
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  // Loader settlement does not reject a failed plugin; each fiber's own await rethrows it.
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { ctx, logs }
}

/** The running server's browser-facing origin. */
function origin(ctx: Context): string {
  return `http://127.0.0.1:${String(ctx.webServer.port)}`
}

/** One served response, reduced to what the assertions read. */
interface Answer {
  status: number
  body: string
}

/**
 * POST one report as a member's console does.
 * @param ctx - the composition.
 * @param assertion - what stands in for the member assertion; absent sends none.
 * @param callId - the call the report names.
 * @param verdict - what the chart answered.
 * @returns the answer.
 */
async function report(ctx: Context, assertion: string | undefined, callId: string, verdict: object = PAINTED): Promise<Answer> {
  const response = await fetch(`${origin(ctx)}${SHOW_CHART_REPORT_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...assertion === undefined ? {} : { [MEMBER_HEADER]: assertion } },
    body: JSON.stringify({ callId, verdict }),
  })
  return { status: response.status, body: await response.text() }
}

/**
 * Report for one call until a waiting call takes it: the wait opens inside the
 * tool body, so a report before the dispatch has reached it is refused.
 * @param ctx - the composition.
 * @param assertion - the member's stand-in assertion.
 * @param callId - the call.
 * @returns the accepting answer.
 */
async function reportUntilTaken(ctx: Context, assertion: string, callId: string): Promise<Answer> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const answer = await report(ctx, assertion, callId)
    if (answer.body === '{"accepted":true}') return answer
    await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 5) })
  }
  throw new Error('no waiting call took the report')
}

/**
 * POST a report that is never finished: its declared length is longer than
 * what is sent, and the request stays open. A route that read the body before
 * answering would wait for the rest, so an answer at all shows it answered
 * without reading.
 * @param ctx - the composition.
 * @param assertion - what stands in for the member assertion; absent sends none.
 * @returns the answer, or a rejection when none arrives within two seconds.
 */
async function reportUnfinished(ctx: Context, assertion: string | undefined): Promise<Answer> {
  const sent = `{"callId":"${CALL_A}","verdict":`
  const req = request(`${origin(ctx)}${SHOW_CHART_REPORT_ROUTE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(sent.length + 64),
      ...assertion === undefined ? {} : { [MEMBER_HEADER]: assertion },
    },
  })
  try {
    return await new Promise<Answer>((resolveAnswer, reject) => {
      const timer = setTimeout(() => { reject(new Error('the report route waited for the rest of the body')) }, 2000)
      req.on('error', reject)
      req.on('response', (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { body += chunk })
        response.on('end', () => {
          clearTimeout(timer)
          resolveAnswer({ status: response.statusCode ?? 0, body })
        })
      })
      req.write(sent)
    })
  } finally {
    req.destroy()
  }
}

/**
 * The JSON document one answer carries.
 * @param answer - the answer.
 * @returns the decoded body.
 */
function documentOf(answer: Answer): unknown {
  const document: unknown = JSON.parse(answer.body)
  return document
}

/**
 * Create the sessions the directory's tables name.
 * @param ctx - the composition.
 * @returns A's session and its child.
 */
function createSessions(ctx: Context): Record<'a' | 'child', Session> {
  // Narrowed rather than cast: this package compiles in the Client aggregate,
  // where the cordis `Context.sessions` merge names the browser service.
  const store = ctx.get('sessions')
  if (!(store instanceof SessionStore)) throw new Error('the composition runs no host session store')
  const a = store.create(SessionId('session-a'))
  return { a, child: store.create(SessionId('session-a-child'), { meta: { parentSession: a.id, origin: 'subagent' } }) }
}

/**
 * Start one `show_chart` call, the way an agent loop would.
 * @param ctx - the composition.
 * @param callId - the call's id.
 * @param session - the session the call runs in; absent starts it outside any agent.
 * @param signal - the call's cancellation.
 * @returns the tool's result.
 */
function draw(
  ctx: Context,
  callId: string,
  session?: Session,
  signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: ToolCallId(callId),
    name: 'show_chart',
    arguments: { title: 'Live', option: { series: [{ type: 'line', data: [1, 2] }] } },
    ...session === undefined ? {} : { agent: { id: session.id, session } as NonNullable<ToolExecutionInput['agent']> },
    signal,
  })
}

/**
 * Require that nothing a test sent or opened reached a response body or a log line.
 * @param answers - the response bodies.
 * @param logs - the composition's log.
 */
function expectNothingQuoted(answers: readonly Answer[], logs: readonly LogLine[]): void {
  const surfaces = [...answers.map(answer => answer.body), ...logs.map(line => line.text)]
  for (const secret of SECRETS) {
    expect({ secret, quotedIn: surfaces.filter(surface => surface.includes(secret)) }).toEqual({ secret, quotedIn: [] })
  }
}

describe('per-member report route', () => {
  it('answers 401 before reading the body of a report it places with nobody', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true, members: MEMBERS })
    const refusal = { error: 'show-chart: the report route could not tell which member sent this request' }
    const answers: Answer[] = []
    for (const assertion of [undefined, ASSERTION_NOBODY]) {
      const unfinished = await reportUnfinished(ctx, assertion)
      const whole = await report(ctx, assertion, CALL_A)
      answers.push(unfinished, whole)
      expect([unfinished, whole].map(answer => ({ status: answer.status, body: documentOf(answer) })))
        .toEqual([{ status: 401, body: refusal }, { status: 401, body: refusal }])
    }
    expectNothingQuoted(answers, logs)
  })

  it('answers 503 before reading the body while no member directory is running, and logs it once the composition has loaded', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true })
    await vi.waitFor(() => { expect(logs.filter(line => line.type === 'error')).toHaveLength(1) })
    expect(logs.filter(line => line.type === 'error')).toEqual([{
      name: 'show-chart',
      type: 'error',
      text: 'perMember is set and no consoleMembers service is running now that the composition has loaded; the report route answers 503 until one is',
    }])
    const refusal = { error: 'show-chart: the report route needs the consoleMembers service, which is not running' }
    const answers = [await reportUnfinished(ctx, ASSERTION_A), await report(ctx, ASSERTION_A, CALL_A)]
    expect(answers.map(answer => ({ status: answer.status, body: documentOf(answer) })))
      .toEqual([{ status: 503, body: refusal }, { status: 503, body: refusal }])
    expectNothingQuoted(answers, logs)
  })

  it('answers another member\'s report exactly as one naming no call, and takes the session\'s own member\'s', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true, members: MEMBERS })
    const sessions = createSessions(ctx)
    const noCall = await report(ctx, ASSERTION_B, 'chart-call-nobody-opened')
    expect({ status: noCall.status, body: noCall.body }).toEqual({ status: 200, body: REFUSED_BODY })
    const waits = vi.spyOn(PendingCharts.prototype, 'settle')
    const drawn = draw(ctx, CALL_A, sessions.a)
    // The call is waiting before B reports: the wait is registered inside the
    // `settle` call itself, so every report below names a call that is open.
    await vi.waitFor(() => { expect(waits).toHaveBeenCalledTimes(1) })
    const answers: Answer[] = [noCall]
    // None of B's reports settles the call.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const forged = await report(ctx, ASSERTION_B, CALL_A, FORGED)
      answers.push(forged)
      expect({ status: forged.status, body: forged.body }).toEqual({ status: noCall.status, body: noCall.body })
      await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    answers.push(await reportUntilTaken(ctx, ASSERTION_A, CALL_A))
    expect((await drawn).content).toEqual([{ type: 'text', text: 'Rendered: Live — 1 series, 2 points' }])
    expectNothingQuoted(answers, logs)
  })

  it('places a child session\'s call with the member its parent belongs to', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true, members: MEMBERS })
    const sessions = createSessions(ctx)
    const drawn = draw(ctx, CALL_CHILD, sessions.child)
    const answers: Answer[] = []
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const forged = await report(ctx, ASSERTION_B, CALL_CHILD, FORGED)
      answers.push(forged)
      expect(forged.body).toBe(REFUSED_BODY)
      await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    answers.push(await reportUntilTaken(ctx, ASSERTION_A, CALL_CHILD))
    expect((await drawn).content).toEqual([{ type: 'text', text: 'Rendered: Live — 1 series, 2 points' }])
    expectNothingQuoted(answers, logs)
  })

  it('takes no member\'s report for a call made outside any agent', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true, members: MEMBERS })
    const cancel = new AbortController()
    const drawn = draw(ctx, CALL_NO_AGENT, undefined, cancel.signal)
    const answers: Answer[] = []
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (const assertion of [ASSERTION_A, ASSERTION_B]) {
        const refused = await report(ctx, assertion, CALL_NO_AGENT)
        answers.push(refused)
        expect(refused.body).toBe(REFUSED_BODY)
      }
      await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    // Nothing settled it, so it waits until it is cancelled.
    cancel.abort()
    expect((await drawn).content).toEqual([{ type: 'text', text: 'Error: tool call aborted' }])
    expectNothingQuoted(answers, logs)
  })

  it('releases the report route when the fiber disposes (HMR safety)', async () => {
    const { ctx } = await loadComposition({ perMember: true, members: MEMBERS })
    const base = origin(ctx)
    // Served by this row before it goes: a report nobody is placed for is refused by the row itself.
    expect((await report(ctx, undefined, CALL_A)).status).toBe(401)
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'show-chart')
    await row?.fiber?.dispose()
    // The webserver's own fallback answers a path nobody claims.
    const answer = await fetch(`${base}${SHOW_CHART_REPORT_ROUTE}`, { method: 'POST', body: '{}' })
    expect(answer.status).toBe(404)
    await answer.arrayBuffer()
  })

  it('logs nothing about a directory that is running', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true, members: MEMBERS })
    await ctx.loader.await()
    await new Promise((resolveTick) => { setImmediate(resolveTick) })
    expect(logs.filter(line => line.type === 'error')).toEqual([])
  })
})

describe('member directory check', () => {
  it('logs nothing for a row disposed before the composition has loaded', async () => {
    const ctx = context = new Context()
    const errors: string[] = []
    ctx.logger.exporter({ export: (message) => { if (message.type === 'error') errors.push(message.name) } })
    let settle = (): void => {}
    const loaded = new Promise<void>((resolveLoaded) => { settle = resolveLoaded })
    // A Loader whose tree has not settled yet; the check reads nothing else of it.
    ctx.provide('loader', { await: () => loaded } as never)
    // Both rows set perMember with no directory running, which is a mismatch the
    // live one reports once the tree settles.
    const gone = ctx.plugin({
      name: 'disposed-row',
      apply: (scope: Context) => { reportDirectoryMismatch(scope, true, scope.logger('disposed-row')) },
    })
    const live = ctx.plugin({
      name: 'live-row',
      apply: (scope: Context) => { reportDirectoryMismatch(scope, true, scope.logger('live-row')) },
    })
    // Both rows have started, and so registered their check, before one goes.
    await Promise.all([gone.await(), live.await()])
    await gone.dispose()
    settle()
    await new Promise((resolveTick) => { setImmediate(resolveTick) })
    expect(errors).toEqual(['live-row'])
  })
})

describe('report route without perMember', () => {
  it('takes any console\'s report for any session\'s call, and logs that a member directory is running', async () => {
    const { ctx, logs } = await loadComposition({ members: MEMBERS })
    await vi.waitFor(() => { expect(logs.filter(line => line.type === 'error')).toHaveLength(1) })
    expect(logs.filter(line => line.type === 'error')).toEqual([{
      name: 'show-chart',
      type: 'error',
      text: 'perMember is off and a consoleMembers service is running now that the composition has loaded; the report route takes a report for any session\'s call from any member',
    }])
    const sessions = createSessions(ctx)
    const drawn = draw(ctx, CALL_A, sessions.a)
    const taken = await reportUntilTaken(ctx, ASSERTION_B, CALL_A)
    expect((await drawn).content).toEqual([{ type: 'text', text: 'Rendered: Live — 1 series, 2 points' }])
    expectNothingQuoted([taken], logs)
  })

  it('logs nothing where no member directory is running', async () => {
    const { ctx, logs } = await loadComposition({ perMember: false })
    await ctx.loader.await()
    await new Promise((resolveTick) => { setImmediate(resolveTick) })
    expect(logs.filter(line => line.type === 'error')).toEqual([])
  })

  it('defaults to taking every report, and does not declare the field volatile', () => {
    expect(ShowChart.Config({}).perMember).toBe(false)
    // A settings write reaches only fields declared `.volatile()`, so this one
    // changes only with the row's own configuration.
    expect(ShowChart.Config.dict?.perMember?.meta.volatile ?? false).toBe(false)
  })
})
