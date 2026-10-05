/**
 * REAL-composition coverage for answering page-read posts per console member:
 * a test-only cordis.yml booted through the vendored Loader mounts the
 * webserver, the tool runtime, the session store and projection registry, a
 * stand-in attachment store and model registry, this row with `perMember`, and
 * — where a case needs one — the test-only `consoleMembers` row from
 * `fixtures/console-members.client.ts`. Every assertion observes the served
 * claim, report, and picture routes, what the stand-in store kept, the tool
 * results, and what the composition logged.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Logger } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ContentFrame from '../src/index.ts'
import { reportDirectoryMismatch } from '../src/access/members.ts'
import { CONTENT_SETTINGS_ROUTE } from '../src/route.ts'
import {
  CONTENT_CLAIM_ROUTE, CONTENT_IMAGE_ROUTE, CONTENT_REPORT_ROUTE, MIN_OUTLINE_CHARS, type ImageCapture, type ReadOutcome,
} from '../src/access/wire.ts'
import { MEMBER_HEADER, type Config as FixtureConfig } from './fixtures/console-members.client.ts'
import { PictureStore } from './fixtures/picture-services.client.ts'

const APP_ROOT = fileURLToPath(new URL('./fixtures/app', import.meta.url))
const MEMBERS_ROW = pathToFileURL(resolve(import.meta.dirname, 'fixtures/console-members.client.ts')).href
const PICTURE_ROW = pathToFileURL(resolve(import.meta.dirname, 'fixtures/picture-services.client.ts')).href

const MEMBER_A = 'member-a-key'
const MEMBER_B = 'member-b-key'
/** What each member's requests carry in place of the signed member assertion. */
const ASSERTION_A = 'assertion-of-a'
const ASSERTION_B = 'assertion-of-b'
const ASSERTION_NOBODY = 'assertion-of-nobody'
/** The tab each member's console answers from; both share one id, so only the member tells them apart. */
const TAB = 'tab-shared-1'

/** The directory's tables: two members, their sessions, a child of A's, and a session nobody owns. */
const MEMBERS: FixtureConfig = {
  requests: { [ASSERTION_A]: MEMBER_A, [ASSERTION_B]: MEMBER_B },
  sessions: { 'session-a': MEMBER_A, 'session-b': MEMBER_B },
  parents: { 'session-a-child': 'session-a', 'session-orphan': 'session-gone' },
}

/** The call ids the cases open; none may reach an answer body or a log line. */
const CALL_A = 'call-of-member-a'
const CALL_CHILD = 'call-of-a-child-session'
const CALL_ORPHAN = 'call-of-nobody'
const CALL_PICTURE = 'call-picture-of-a'

/** Every value no response body and no log line may carry. */
const SECRETS = [
  MEMBER_A, MEMBER_B, ASSERTION_A, ASSERTION_B, ASSERTION_NOBODY, TAB, CALL_A, CALL_CHILD, CALL_ORPHAN, CALL_PICTURE,
]

/** One listing, as a browser seat posts it. */
const LISTING: ReadOutcome = {
  status: 'ok',
  page: { id: 'home', title: 'Home' },
  snapshot: {
    kind: 'outline',
    url: 'http://127.0.0.1/content-app/',
    title: 'Hosted content app',
    text: '1 heading "Hosted content app"',
    truncated: false,
    shown: 1,
    total: 1,
    settled: true,
  },
}

/** One capture as a seat posts it: three bytes of PNG, base64. */
const CAPTURE: ImageCapture = {
  status: 'captured',
  page: { id: 'home', title: 'Home' },
  url: 'http://127.0.0.1/content-app/',
  ref: 'e12',
  tag: 'img',
  natural: { width: 240, height: 240 },
  settled: true,
  mediaType: 'image/png',
  data: 'AQID',
}

/** The three routes, each with a body of the document it takes and the name its refusals use. */
const ROUTES = [
  { path: CONTENT_CLAIM_ROUTE, name: 'the read claim route', body: { callId: CALL_A, tabId: TAB } },
  { path: CONTENT_REPORT_ROUTE, name: 'the read report route', body: { callId: CALL_A, tabId: TAB, outcome: LISTING } },
  { path: CONTENT_IMAGE_ROUTE, name: 'the picture report route', body: { callId: CALL_A, tabId: TAB, capture: CAPTURE } },
] as const

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
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
 * @param options - the row's `perMember` (absent leaves the field out), the
 * directory row's tables (absent leaves the row out), and whether the row
 * configures `pageAccess` (absent configures it).
 * @returns the booted context and its log.
 */
async function loadComposition(
  options: { perMember?: boolean; members?: FixtureConfig; pageAccess?: boolean },
): Promise<Composition> {
  world = await mkdtemp(join(tmpdir(), 'dsh-content-read-members-'))
  const configPath = join(world, 'cordis.yml')
  const rows: unknown[] = [
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-session' },
    { name: '@deepseek-ai/dsh-session-projection' },
    { name: PICTURE_ROW },
    {
      id: 'content-frame',
      name: '@deepseek-ai/dsh-experimental-content-frame',
      config: {
        root: APP_ROOT,
        pages: [{ id: 'home', title: 'Home', description: "The hosted application's entry page.", url: '/content-app/' }],
        ...options.pageAccess === false
          ? {}
          : { pageAccess: { claimTimeoutMs: 5000, readTimeoutMs: 5000, pinMs: 60000, outlineChars: MIN_OUTLINE_CHARS } },
        ...options.perMember === undefined ? {} : { perMember: options.perMember },
      },
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
 * POST one JSON document to a read route as a member's console does.
 * @param ctx - the composition.
 * @param path - the route.
 * @param assertion - what stands in for the member assertion; absent sends none.
 * @param body - the document.
 * @returns the answer.
 */
async function post(ctx: Context, path: string, assertion: string | undefined, body: unknown): Promise<Answer> {
  const response = await fetch(`${origin(ctx)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...assertion === undefined ? {} : { [MEMBER_HEADER]: assertion } },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.text() }
}

/**
 * POST to a route a body that is never finished: its declared length is longer
 * than what is sent, and the request stays open. A route that read the body
 * before answering would wait for the rest, so an answer at all shows it
 * answered without reading.
 * @param ctx - the composition.
 * @param path - the route.
 * @param assertion - what stands in for the member assertion; absent sends none.
 * @returns the answer, or a rejection when none arrives within two seconds.
 */
async function postUnfinished(ctx: Context, path: string, assertion: string | undefined): Promise<Answer> {
  const sent = `{"callId":"${CALL_A}","tabId":"`
  const req = request(`${origin(ctx)}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(sent.length + 64),
      ...assertion === undefined ? {} : { [MEMBER_HEADER]: assertion },
    },
  })
  try {
    return await new Promise<Answer>((resolveAnswer, reject) => {
      const timer = setTimeout(() => { reject(new Error(`${path} waited for the rest of the body`)) }, 2000)
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
 * The composition's host session store.
 * @param ctx - the composition.
 * @returns the store.
 */
function storeOf(ctx: Context): SessionStore {
  // Narrowed rather than cast: this package compiles in the Client aggregate,
  // where the cordis `Context.sessions` merge names the browser service.
  const sessions = ctx.get('sessions')
  if (!(sessions instanceof SessionStore)) throw new Error('the composition runs no host session store')
  return sessions
}

/**
 * The composition's stand-in attachment store.
 * @param ctx - the composition.
 * @returns the store.
 */
function picturesOf(ctx: Context): PictureStore {
  const attachments = ctx.get('attachments')
  if (!(attachments instanceof PictureStore)) throw new Error('the composition runs no stand-in attachment store')
  return attachments
}

/**
 * Create the sessions the directory's tables name.
 * @param ctx - the composition.
 * @returns A's session, its child, B's session, and the session nobody owns.
 */
function createSessions(ctx: Context): Record<'a' | 'child' | 'b' | 'orphan', Session> {
  const store = storeOf(ctx)
  const a = store.create(SessionId('session-a'))
  return {
    a,
    child: store.create(SessionId('session-a-child'), { meta: { parentSession: a.id, origin: 'subagent' } }),
    b: store.create(SessionId('session-b')),
    orphan: store.create(SessionId('session-orphan'), { meta: { parentSession: SessionId('session-gone') } }),
  }
}

/**
 * Start one read tool for a session, the way an agent loop would.
 * @param ctx - the composition.
 * @param session - the session the call runs in.
 * @param callId - the call's id.
 * @param picture - start `content_read_image` of one element rather than `content_read`.
 * @param signal - the call's cancellation.
 * @returns the tool's result.
 */
function startRead(
  ctx: Context,
  session: Session,
  callId: string,
  picture = false,
  signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  // The picture read's modality gate reads the agent's options when the
  // session has made no request yet.
  const agent = { id: session.id, session, options: { provider: 'stub', model: 'vision' } }
  return ctx.tools.execute({
    callId: ToolCallId(callId),
    name: picture ? 'content_read_image' : 'content_read',
    arguments: picture ? { ref: 'e12' } : {},
    agent: agent as NonNullable<ToolExecutionInput['agent']>,
    signal,
  })
}

/**
 * Claim one call as a member's console does, retrying while the tool body is
 * still registering its wait: a claim before the dispatch has reached it is
 * answered `unknown`.
 * @param ctx - the composition.
 * @param assertion - the member's stand-in assertion.
 * @param callId - the call being claimed.
 * @returns the winning answer.
 */
async function claimAs(ctx: Context, assertion: string, callId: string): Promise<Answer> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const answer = await post(ctx, CONTENT_CLAIM_ROUTE, assertion, { callId, tabId: TAB })
    if (answer.body.startsWith('{"claimed":true')) return answer
    await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 5) })
  }
  throw new Error('the case never claimed its call')
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

/** The answers a call no member owns gets, written out as they cross the wire for a call this host does not know. */
const UNKNOWN_CLAIM_BODY = '{"claimed":false,"reason":"unknown"}'
const REFUSED_REPORT_BODY = '{"accepted":false}'

describe('per-member read routes', () => {
  it('answers 401 before reading the body of a post it places with nobody', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true, members: MEMBERS })
    const answers: Answer[] = []
    for (const route of ROUTES) {
      for (const assertion of [undefined, ASSERTION_NOBODY]) {
        const refusal = { error: `content-frame: ${route.name} could not tell which member sent this request` }
        const unfinished = await postUnfinished(ctx, route.path, assertion)
        const whole = await post(ctx, route.path, assertion, route.body)
        answers.push(unfinished, whole)
        expect([unfinished, whole].map(answer => ({ route: route.path, status: answer.status, body: documentOf(answer) })))
          .toEqual([{ route: route.path, status: 401, body: refusal }, { route: route.path, status: 401, body: refusal }])
      }
    }
    expect(picturesOf(ctx).saved).toEqual([])
    expectNothingQuoted(answers, logs)
  })

  it('answers 503 before reading the body while no member directory is running, and logs it once the composition has loaded', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true })
    await vi.waitFor(() => { expect(logs.filter(line => line.type === 'error')).toHaveLength(1) })
    expect(logs.filter(line => line.type === 'error')).toEqual([{
      name: 'content-frame',
      type: 'error',
      text: 'perMember is set and no consoleMembers service is running now that the composition has loaded; the page read routes answer 503 until one is',
    }])
    const answers: Answer[] = []
    for (const route of ROUTES) {
      const refusal = { error: `content-frame: ${route.name} needs the consoleMembers service, which is not running` }
      const unfinished = await postUnfinished(ctx, route.path, ASSERTION_A)
      const whole = await post(ctx, route.path, ASSERTION_A, route.body)
      answers.push(unfinished, whole)
      expect([unfinished, whole].map(answer => ({ route: route.path, status: answer.status, body: documentOf(answer) })))
        .toEqual([{ route: route.path, status: 503, body: refusal }, { route: route.path, status: 503, body: refusal }])
    }
    expectNothingQuoted(answers, logs)
  })

  it('lets the member a session belongs to claim and report its call', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true, members: MEMBERS })
    const sessions = createSessions(ctx)
    const settled = startRead(ctx, sessions.a, CALL_A)
    const claim = await claimAs(ctx, ASSERTION_A, CALL_A)
    const report = await post(ctx, CONTENT_REPORT_ROUTE, ASSERTION_A, { callId: CALL_A, tabId: TAB, outcome: LISTING })
    expect([claim.status, documentOf(report)]).toEqual([200, { accepted: true }])
    expect((await settled).content).toEqual([{
      type: 'text',
      text: 'Page: Home — the app is at /content-app/, title "Hosted content app"\n1 heading "Hosted content app"',
    }])
    // A settled call is still told apart from an unknown one for its own member.
    const late = await post(ctx, CONTENT_CLAIM_ROUTE, ASSERTION_A, { callId: CALL_A, tabId: TAB })
    expect(documentOf(late)).toEqual({ claimed: false, reason: 'settled' })
    expectNothingQuoted([claim, report, late], logs)
  })

  it('answers another member\'s post for a call exactly as one naming no call, and keeps the call for its own member', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true, members: MEMBERS })
    const sessions = createSessions(ctx)
    const answers: Answer[] = []
    const unknown = await post(ctx, CONTENT_CLAIM_ROUTE, ASSERTION_B, { callId: 'call-nobody-opened', tabId: TAB })
    expect({ status: unknown.status, body: unknown.body }).toEqual({ status: 200, body: UNKNOWN_CLAIM_BODY })
    const settled = startRead(ctx, sessions.a, CALL_A)

    // B bids while the call opens and waits unclaimed; none of the bids takes
    // it, because A's own bid is the one that wins.
    for (let bid = 0; bid < 20; bid += 1) {
      const crossed = await post(ctx, CONTENT_CLAIM_ROUTE, ASSERTION_B, { callId: CALL_A, tabId: TAB })
      answers.push(crossed)
      expect({ status: crossed.status, body: crossed.body }).toEqual({ status: unknown.status, body: unknown.body })
      await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    answers.push(await claimAs(ctx, ASSERTION_A, CALL_A))
    // Now claimed: A's other tab is told another tab holds it, and B is still told nothing is known of it.
    const ownOtherTab = await post(ctx, CONTENT_CLAIM_ROUTE, ASSERTION_A, { callId: CALL_A, tabId: 'tab-other' })
    const crossedClaimed = await post(ctx, CONTENT_CLAIM_ROUTE, ASSERTION_B, { callId: CALL_A, tabId: 'tab-other' })
    expect([ownOtherTab.body, crossedClaimed.body]).toEqual(['{"claimed":false,"reason":"taken"}', UNKNOWN_CLAIM_BODY])

    // B reports for the call A holds, from A's own tab id: refused, and the call keeps waiting.
    const forged = await post(ctx, CONTENT_REPORT_ROUTE, ASSERTION_B, { callId: CALL_A, tabId: TAB, outcome: LISTING })
    const noCall = await post(ctx, CONTENT_REPORT_ROUTE, ASSERTION_B, { callId: 'call-nobody-opened', tabId: TAB, outcome: LISTING })
    expect([forged, noCall].map(answer => ({ status: answer.status, body: answer.body })))
      .toEqual([{ status: 200, body: REFUSED_REPORT_BODY }, { status: 200, body: REFUSED_REPORT_BODY }])
    const report = await post(ctx, CONTENT_REPORT_ROUTE, ASSERTION_A, { callId: CALL_A, tabId: TAB, outcome: LISTING })
    expect(documentOf(report)).toEqual({ accepted: true })
    expect((await settled).content).toEqual([{
      type: 'text',
      text: 'Page: Home — the app is at /content-app/, title "Hosted content app"\n1 heading "Hosted content app"',
    }])

    // Once settled, A is told it settled and B is told nothing is known of it.
    const ownLate = await post(ctx, CONTENT_CLAIM_ROUTE, ASSERTION_A, { callId: CALL_A, tabId: TAB })
    const crossedLate = await post(ctx, CONTENT_CLAIM_ROUTE, ASSERTION_B, { callId: CALL_A, tabId: TAB })
    expect([ownLate.body, crossedLate.body]).toEqual(['{"claimed":false,"reason":"settled"}', UNKNOWN_CLAIM_BODY])
    answers.push(unknown, ownOtherTab, crossedClaimed, forged, noCall, report, ownLate, crossedLate)
    expectNothingQuoted(answers, logs)
  })

  it('places a child session\'s call with the member its parent belongs to, and a call of nobody\'s session with nobody', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true, members: MEMBERS })
    const sessions = createSessions(ctx)
    const cancel = new AbortController()
    const child = startRead(ctx, sessions.child, CALL_CHILD)
    const orphan = startRead(ctx, sessions.orphan, CALL_ORPHAN, false, cancel.signal)
    const answers: Answer[] = []
    for (let bid = 0; bid < 20; bid += 1) {
      for (const [assertion, callId] of [[ASSERTION_B, CALL_CHILD], [ASSERTION_A, CALL_ORPHAN], [ASSERTION_B, CALL_ORPHAN]]) {
        const refused = await post(ctx, CONTENT_CLAIM_ROUTE, assertion, { callId, tabId: TAB })
        answers.push(refused)
        expect(refused.body).toBe(UNKNOWN_CLAIM_BODY)
      }
      await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 5) })
    }
    answers.push(await claimAs(ctx, ASSERTION_A, CALL_CHILD))
    answers.push(await post(ctx, CONTENT_REPORT_ROUTE, ASSERTION_A, { callId: CALL_CHILD, tabId: TAB, outcome: LISTING }))
    expect(documentOf(answers.at(-1)!)).toEqual({ accepted: true })
    expect((await child).content.map(block => block.type)).toEqual(['text'])
    // Nobody owns the orphan's session, so neither member could claim its call;
    // it waits until it is cancelled.
    cancel.abort()
    await orphan
    expectNothingQuoted(answers, logs)
  })

  it('stores no picture another member posts, and stores the one the session\'s own member posts', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true, members: MEMBERS })
    const sessions = createSessions(ctx)
    const settled = startRead(ctx, sessions.a, CALL_PICTURE, true)
    const claim = await claimAs(ctx, ASSERTION_A, CALL_PICTURE)
    const forged = await post(ctx, CONTENT_IMAGE_ROUTE, ASSERTION_B, { callId: CALL_PICTURE, tabId: TAB, capture: CAPTURE })
    const noCall = await post(ctx, CONTENT_IMAGE_ROUTE, ASSERTION_B, { callId: 'call-nobody-opened', tabId: TAB, capture: CAPTURE })
    expect([forged, noCall].map(answer => ({ status: answer.status, body: answer.body })))
      .toEqual([{ status: 200, body: REFUSED_REPORT_BODY }, { status: 200, body: REFUSED_REPORT_BODY }])
    expect(picturesOf(ctx).saved).toEqual([])
    const own = await post(ctx, CONTENT_IMAGE_ROUTE, ASSERTION_A, { callId: CALL_PICTURE, tabId: TAB, capture: CAPTURE })
    expect(documentOf(own)).toEqual({ accepted: true })
    expect(picturesOf(ctx).saved.map(image => image.name)).toEqual(['content-home-e12.png'])
    expect((await settled).content.map(block => block.type)).toEqual(['text', 'image'])
    expectNothingQuoted([claim, forged, noCall, own], logs)
  })

  it('releases every read route when the fiber disposes (HMR safety)', async () => {
    const { ctx } = await loadComposition({ perMember: true, members: MEMBERS })
    const base = origin(ctx)
    // Served by this row before it goes: a post nobody is placed for is refused by the row itself.
    for (const route of ROUTES) {
      const live = await post(ctx, route.path, undefined, route.body)
      expect({ path: route.path, status: live.status }).toEqual({ path: route.path, status: 401 })
    }
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'content-frame')
    await row?.fiber?.dispose()
    for (const route of ROUTES) {
      // The webserver's own fallback answers a path nobody claims.
      const answer = await fetch(`${base}${route.path}`, { method: 'POST', body: '{}' })
      expect({ path: route.path, status: answer.status }).toEqual({ path: route.path, status: 404 })
      await answer.arrayBuffer()
    }
  })
})

describe('read routes without perMember', () => {
  it('lets any console answer any session\'s call, and logs that a member directory is running', async () => {
    const { ctx, logs } = await loadComposition({ members: MEMBERS })
    await vi.waitFor(() => { expect(logs.filter(line => line.type === 'error')).toHaveLength(1) })
    expect(logs.filter(line => line.type === 'error')).toEqual([{
      name: 'content-frame',
      type: 'error',
      text: 'perMember is off and a consoleMembers service is running now that the composition has loaded; the page read routes take a claim or report for any session\'s call from any member',
    }])
    const sessions = createSessions(ctx)
    const settled = startRead(ctx, sessions.a, CALL_A)
    const claim = await claimAs(ctx, ASSERTION_B, CALL_A)
    const report = await post(ctx, CONTENT_REPORT_ROUTE, undefined, { callId: CALL_A, tabId: TAB, outcome: LISTING })
    expect(documentOf(report)).toEqual({ accepted: true })
    await settled
    expectNothingQuoted([claim, report], logs)
  })

  it('logs nothing where no member directory is running', async () => {
    const { ctx, logs } = await loadComposition({ perMember: false })
    await ctx.loader.await()
    await new Promise((resolveTick) => { setImmediate(resolveTick) })
    expect(logs.filter(line => line.type === 'error')).toEqual([])
  })

  it('defaults to answering every post, and does not declare the field volatile', () => {
    const resolved = ContentFrame.Config({
      root: APP_ROOT,
      pages: [{ id: 'home', title: 'Home', description: 'Home.', url: '/content-app/' }],
    })
    expect(resolved.perMember).toBe(false)
    // A settings write reaches only fields declared `.volatile()`, so this one
    // changes only with the row's own configuration.
    expect(ContentFrame.Config.dict?.perMember?.meta.volatile ?? false).toBe(false)
  })
})

describe('per-member configuration', () => {
  it('refuses at load a row that sets perMember without pageAccess', async () => {
    // Only the page read routes answer per member, and without pageAccess the
    // row registers none of them, so the setting would have nothing to act on.
    await expect(loadComposition({ perMember: true, members: MEMBERS, pageAccess: false })).rejects.toThrow(
      'content-frame: perMember needs pageAccess, because only the page read routes answer per member',
    )
  })

  it('takes a row without perMember and without pageAccess', async () => {
    const { ctx } = await loadComposition({ perMember: false, pageAccess: false })
    const settings = await fetch(`${origin(ctx)}${CONTENT_SETTINGS_ROUTE}`)
    expect(settings.status).toBe(200)
    await settings.arrayBuffer()
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

describe('per-member read routes beside a running directory', () => {
  it('logs nothing about a directory that is running', async () => {
    const { ctx, logs } = await loadComposition({ perMember: true, members: MEMBERS })
    await ctx.loader.await()
    await new Promise((resolveTick) => { setImmediate(resolveTick) })
    expect(logs.filter(line => line.type === 'error')).toEqual([])
  })
})
