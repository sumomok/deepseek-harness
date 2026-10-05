/**
 * REAL-composition coverage for holding one token per console member: a
 * test-only cordis.yml booted through the vendored Loader mounts the
 * webserver, the auth-gate row with `perMember`, and — where a case needs one —
 * the test-only `consoleMembers` row from `fixtures/console-members.client.ts`;
 * a fixture HTTP server stands in for the deployment's data backend. Every
 * assertion observes the served routes, what the data backend was sent, what
 * the member directory was lent, and what the row logged.
 *
 * The configuration cases call `apply` directly: a rejected configuration
 * never reaches a served surface, so there is nothing for HTTP to observe.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { createServer, IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Socket, type AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Logger } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  BizBackendService,
  BizOperationRules,
  type BizSubject,
  type PrincipalKey,
} from '@deepseek-ai/dsh-experimental-biz-backend'
import * as AuthGate from '../src/index.ts'
import { AUTH_GATE_LOGOUT_ROUTE, AUTH_GATE_SETTINGS_ROUTE, AUTH_GATE_TOKEN_ROUTE } from '../src/route.ts'
import type { CustomerCredentialReader } from '../src/member-directory.ts'
import { ConsoleMembersFixture, MEMBER_HEADER, type Config as FixtureConfig } from './fixtures/console-members.client.ts'

/** The subject a tool call's reads name. */
type SessionSubject = Extract<BizSubject, { kind: 'session' }>

const FIXTURE_ROW = pathToFileURL(resolve(import.meta.dirname, 'fixtures/console-members.client.ts')).href

/**
 * A JWT-shaped token whose payload is the given JSON text, written by hand so
 * a number in it keeps every digit it was written with.
 * @param payload - the payload's JSON text.
 * @returns the token.
 */
function jwt(payload: string): string {
  return `aGVhZGVy.${Buffer.from(payload, 'utf8').toString('base64url')}.c2ln`
}

/** Member A's key: a 19-digit id, past what a double holds exactly. */
const MEMBER_A = '1234567890123456789'
const MEMBER_B = 'member-b'
/** Member A's token, its claim written as a JSON number. */
const TOKEN_A = jwt(`{"login_uid":${MEMBER_A},"sub":"a"}`)
const TOKEN_A_RENEWED = jwt(`{"login_uid":${MEMBER_A},"sub":"a","jti":"renewed"}`)
const TOKEN_B = jwt(`{"login_uid":"${MEMBER_B}","sub":"b"}`)
const TOKEN_B_AGAIN = jwt(`{"login_uid":"${MEMBER_B}","sub":"b","jti":"again"}`)
/** What each member's requests carry in place of the signed member assertion. */
const ASSERTION_A = 'assertion-of-a'
const ASSERTION_B = 'assertion-of-b'
const ASSERTION_NOBODY = 'assertion-of-nobody'

/** The directory's tables: two members, their top-level sessions, and the children it places. */
const MEMBERS: FixtureConfig = {
  requests: { [ASSERTION_A]: MEMBER_A, [ASSERTION_B]: MEMBER_B },
  sessions: { 'session-a': MEMBER_A, 'session-b': MEMBER_B },
  parents: { 'session-a-child': 'session-a', 'session-a-grandchild': 'session-a-child', 'session-orphan': 'session-gone' },
}

/** Every value no response body and no log line may carry. */
const SECRETS = [TOKEN_A, TOKEN_A_RENEWED, TOKEN_B, TOKEN_B_AGAIN, MEMBER_A, MEMBER_B, ASSERTION_A, ASSERTION_B, ASSERTION_NOBODY]

let world: string | undefined
let context: Context | undefined
let backend: FixtureBackend | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await backend?.close()
  backend = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** The data backend the gate's reads reach, standing in for the deployment's. */
interface FixtureBackend {
  /** The base the row is configured with. */
  base: string
  /** The `Authorization` header of every request that reached it, in arrival order. */
  presented: string[]
  /** Tokens it answers 401 for, as the deployment's backend does for a refused credential. */
  refused: Set<string>
  close(): Promise<void>
}

/**
 * Start the fixture data backend: every request is answered with an empty
 * rights table, unless its bearer token is in `refused`, which is answered 401.
 * @returns the running fixture.
 */
async function startBackend(): Promise<FixtureBackend> {
  const presented: string[] = []
  const refused = new Set<string>()
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const authorization = req.headers.authorization ?? ''
    presented.push(authorization)
    if (refused.has(authorization.replace(/^Bearer /, ''))) {
      res.writeHead(401)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { auth: { resclass: [], rows: [] } } }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${String(port)}/ini-server/`,
    presented,
    refused,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}

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
 * @param options - the gate's per-member fields, the directory row's tables
 * (absent leaves the row out), and the data backend the gate reads.
 * @returns the booted context and its log.
 */
async function loadComposition(options: {
  gate?: Partial<Pick<AuthGate.Config, 'perMember' | 'principalClaim' | 'shareWithMemberDirectory'>>
  members?: FixtureConfig
  bizUpstream?: string
}): Promise<Composition> {
  world = await mkdtemp(join(tmpdir(), 'dsh-auth-gate-members-'))
  const configPath = join(world, 'cordis.yml')
  // The directory row comes after the gate, so the gate starts before any
  // member directory is running and finds it when it arrives.
  const rows: unknown[] = [
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    {
      id: 'auth-gate',
      name: '@deepseek-ai/dsh-experimental-auth-gate',
      config: {
        loginUrl: '/toy-proxy/toy-login/#/',
        cookieName: 'accessToken',
        refreshMarginSeconds: 300,
        mcpUpstreams: {},
        perMember: true,
        principalClaim: 'login_uid',
        ...options.bizUpstream === undefined ? {} : { bizUpstream: options.bizUpstream },
        ...options.gate,
      },
    },
    ...options.members === undefined ? [] : [{ id: 'console-members', name: FIXTURE_ROW, config: options.members }],
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
 * POST to one of the gate's routes as a member's page does.
 * @param ctx - the composition.
 * @param path - the route.
 * @param assertion - what stands in for the member assertion; absent sends none.
 * @param body - the body, sent as JSON.
 * @param headers - further headers.
 * @returns the answer.
 */
async function post(
  ctx: Context,
  path: string,
  assertion: string | undefined,
  body?: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const response = await fetch(`${origin(ctx)}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...assertion === undefined ? {} : { [MEMBER_HEADER]: assertion },
      ...headers,
    },
    ...body === undefined ? {} : { body },
  })
  return { status: response.status, body: await response.text() }
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

/** POST one token document for a member. */
function postToken(ctx: Context, assertion: string | undefined, token: string): Promise<Answer> {
  return post(ctx, AUTH_GATE_TOKEN_ROUTE, assertion, JSON.stringify({ token }))
}

/** POST one sign-out for a member. */
function postLogout(ctx: Context, assertion: string | undefined): Promise<Answer> {
  return post(ctx, AUTH_GATE_LOGOUT_ROUTE, assertion)
}

/**
 * The directory row's instance.
 * @param ctx - the composition.
 * @returns the fixture the gate was given.
 */
function directoryOf(ctx: Context): ConsoleMembersFixture {
  const directory = ctx.get('consoleMembers')
  if (!(directory instanceof ConsoleMembersFixture)) throw new Error('the composition runs no fixture directory')
  return directory
}

/**
 * The reader the directory row holds.
 * @param ctx - the composition.
 * @returns the reader the gate lent it.
 */
function readerOf(ctx: Context): CustomerCredentialReader {
  const reader = directoryOf(ctx).reader
  if (reader === undefined) throw new Error('the gate lent the directory no reader')
  return reader
}

/**
 * The data-backend service the gate constructed.
 * @param ctx - the composition.
 * @returns the service.
 */
function backendOf(ctx: Context): BizBackendService {
  const service = ctx.get('bizBackend')
  if (service === undefined) throw new Error('the gate constructed no data-backend service')
  return service
}

/** A session subject. */
function session(id: string): SessionSubject {
  return { kind: 'session', sessionId: brandString<SessionSubject['sessionId']>(id) }
}

/** A principal subject. */
function member(principal: string): BizSubject {
  return { kind: 'principal', principal: brandString<PrincipalKey>(principal) }
}

/**
 * Require that nothing a test sent or held reached a response body or a log line.
 * @param answers - the response bodies.
 * @param logs - the composition's log.
 */
function expectNothingQuoted(answers: readonly Answer[], logs: readonly LogLine[]): void {
  const surfaces = [...answers.map(answer => answer.body), ...logs.map(line => line.text)]
  for (const secret of SECRETS) {
    expect({ secret, quotedIn: surfaces.filter(surface => surface.includes(secret)) }).toEqual({ secret, quotedIn: [] })
  }
}

describe('per-member configuration', () => {
  /**
   * Apply the plugin against a webServer that only records what it claimed.
   * @param fields - the per-member fields under test and, where a case needs
   * them, the MCP upstreams.
   * @returns the routes the row claimed.
   */
  function claimedRoutes(fields: Partial<AuthGate.Config>): string[] {
    const claimed: string[] = []
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (route: { path: string }) => {
        claimed.push(route.path)
        return () => {}
      },
    } as never)
    AuthGate.apply(ctx, {
      loginUrl: '/toy-proxy/toy-login/#/',
      cookieName: 'accessToken',
      refreshMarginSeconds: 300,
      mcpUpstreams: {},
      bizOperationRules: BizOperationRules({}),
      ...fields,
    })
    return claimed
  }

  /**
   * The message one configuration is refused with.
   * @param fields - the configuration under test.
   * @returns the refusal's text.
   */
  function refusalOf(fields: Partial<AuthGate.Config>): string {
    try {
      claimedRoutes(fields)
    } catch (refusal) {
      return String(refusal)
    }
    throw new Error('the configuration was accepted')
  }

  it('refuses to lend a reader while one token serves the whole process', () => {
    for (const holding of [{}, { perMember: false }]) {
      expect(refusalOf({ ...holding, shareWithMemberDirectory: true, principalClaim: 'login_uid' })).toBe(
        'Error: auth-gate: shareWithMemberDirectory needs perMember, because only per-member tokens are lent to the member directory',
      )
    }
  })

  it('refuses per-member holding with no claim to compare a posted token on', () => {
    for (const claim of [{}, { principalClaim: '' }]) {
      expect(refusalOf({ perMember: true, ...claim })).toBe(
        'Error: auth-gate: perMember needs a principalClaim naming the token claim each member is compared on',
      )
    }
  })

  it('refuses per-member holding with an MCP upstream, naming the field and not the upstream', () => {
    const refusal = refusalOf({ perMember: true, principalClaim: 'login_uid', mcpUpstreams: { crm: 'https://mcp.internal/crm' } })
    expect(refusal).toBe(
      'Error: auth-gate: mcpUpstreams must be empty when perMember is set, because a forwarded MCP request comes from the MCP client inside this process and names no member',
    )
    expect(refusal).not.toContain('mcp.internal')
    expect(refusal).not.toContain('crm')
  })

  it('claims the settings, token, and sign-out routes and no forwarding route per member', () => {
    expect(claimedRoutes({ perMember: true, principalClaim: 'login_uid', shareWithMemberDirectory: true }))
      .toEqual([AUTH_GATE_SETTINGS_ROUTE, AUTH_GATE_TOKEN_ROUTE, AUTH_GATE_LOGOUT_ROUTE])
  })

  it('reads no claim while one token serves the whole process', () => {
    // A claim with no per-member holding to compare it in is ignored, and the
    // row forwards as it always has.
    expect(claimedRoutes({ principalClaim: 'login_uid', mcpUpstreams: { crm: 'https://mcp.internal/crm' } }))
      .toEqual([AUTH_GATE_SETTINGS_ROUTE, AUTH_GATE_TOKEN_ROUTE, AUTH_GATE_LOGOUT_ROUTE, '/auth-gate/mcp/crm'])
  })

  it('defaults to one token for the process, and declares none of the three fields volatile', () => {
    const resolved = AuthGate.Config({
      loginUrl: '/toy-proxy/toy-login/#/',
      cookieName: 'accessToken',
      refreshMarginSeconds: 300,
      mcpUpstreams: {},
      bizOperationRules: BizOperationRules({}),
    })
    expect([resolved.perMember, resolved.principalClaim, resolved.shareWithMemberDirectory]).toEqual([false, undefined, false])
    // A settings write reaches only fields declared `.volatile()`, so these
    // three change only with the row's own configuration.
    for (const field of ['perMember', 'principalClaim', 'shareWithMemberDirectory']) {
      expect({ field, volatile: AuthGate.Config.dict?.[field]?.meta.volatile ?? false }).toEqual({ field, volatile: false })
    }
    expect(AuthGate.Config.meta.volatile ?? false).toBe(false)
  })
})

describe('per-member token route', () => {
  it('holds a token for the member its claim names, compared digit for digit', async () => {
    const { ctx, logs } = await loadComposition({ members: MEMBERS, gate: { shareWithMemberDirectory: true } })
    const answer = await postToken(ctx, ASSERTION_A, TOKEN_A)
    expect({ status: answer.status, body: answer.body }).toEqual({ status: 204, body: '' })
    expect(readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_A))).toBe(TOKEN_A)
    // The same id as a string claim names the same member.
    const asString = jwt(`{"login_uid":"${MEMBER_A}"}`)
    expect((await postToken(ctx, ASSERTION_A, asString)).status).toBe(204)
    expect(readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_A))).toBe(asString)
    expect(logs.filter(line => line.type === 'error')).toEqual([])
  })

  it('answers 401 before reading the body of a request it places with nobody', async () => {
    const { ctx, logs } = await loadComposition({ members: MEMBERS, gate: { shareWithMemberDirectory: true } })
    const answers: Answer[] = []
    for (const assertion of [undefined, ASSERTION_NOBODY]) {
      // A body that is not JSON at all: a 400 here would mean it was read.
      const answer = await post(ctx, AUTH_GATE_TOKEN_ROUTE, assertion, 'not json at all')
      answers.push(answer)
      expect({ assertion, status: answer.status, body: documentOf(answer) }).toEqual({
        assertion,
        status: 401,
        body: { error: 'auth-gate: the token route could not tell which member sent this request' },
      })
      answers.push(await postToken(ctx, assertion, TOKEN_A))
    }
    expect(answers.map(answer => answer.status)).toEqual([401, 401, 401, 401])
    expect(readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_A))).toBeUndefined()
    expectNothingQuoted(answers, logs)
  })

  it('refuses a body that does not carry a JWT once the member is placed', async () => {
    const { ctx } = await loadComposition({ members: MEMBERS })
    const answer = await post(ctx, AUTH_GATE_TOKEN_ROUTE, ASSERTION_A, JSON.stringify({ token: 'two.segments' }))
    expect({ status: answer.status, body: documentOf(answer) })
      .toEqual({ status: 400, body: { error: 'auth-gate: expected a JSON body whose "token" field is a JWT' } })
  })

  it('answers 409 for a token naming somebody else, and keeps what the member held', async () => {
    const { ctx, logs } = await loadComposition({ members: MEMBERS, gate: { shareWithMemberDirectory: true } })
    expect((await postToken(ctx, ASSERTION_A, TOKEN_A)).status).toBe(204)
    const changes: string[] = []
    readerOf(ctx).onChange((principal, kind) => { changes.push(`${principal}:${kind}`) })
    const answers: Answer[] = []
    for (const token of [
      TOKEN_B,
      // What the 19-digit id becomes once rounded to a double: a different member.
      jwt('{"login_uid":1234567890123456800}'),
      jwt('{"sub":"a"}'),
      jwt('{"login_uid":""}'),
      jwt('not json'),
    ]) {
      const answer = await postToken(ctx, ASSERTION_A, token)
      answers.push(answer)
      expect({ token, status: answer.status, body: documentOf(answer) }).toEqual({
        token,
        status: 409,
        body: { error: 'auth-gate: the posted token names a different member than the one who sent it' },
      })
    }
    expect(readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_A))).toBe(TOKEN_A)
    expect(readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_B))).toBeUndefined()
    expect(changes).toEqual([])
    expectNothingQuoted(answers, logs)
  })

  it('tells the reader\'s subscribers when a member\'s token changes, and not when the same one arrives again', async () => {
    const { ctx } = await loadComposition({ members: MEMBERS, gate: { shareWithMemberDirectory: true } })
    const changes: string[] = []
    readerOf(ctx).onChange((principal, kind) => { changes.push(`${principal}:${kind}`) })
    await postToken(ctx, ASSERTION_A, TOKEN_A)
    await postToken(ctx, ASSERTION_A, TOKEN_A)
    await postToken(ctx, ASSERTION_A, TOKEN_A_RENEWED)
    await postLogout(ctx, ASSERTION_A)
    await postLogout(ctx, ASSERTION_A)
    expect(changes).toEqual([`${MEMBER_A}:set`, `${MEMBER_A}:set`, `${MEMBER_A}:dropped`])
  })

  it('holds the token and logs a fixed line when a subscriber of the reader throws', async () => {
    const { ctx, logs } = await loadComposition({ members: MEMBERS, gate: { shareWithMemberDirectory: true } })
    readerOf(ctx).onChange((principal) => { throw new Error(`subscriber saw ${principal} and ${TOKEN_A}`) })
    const answer = await postToken(ctx, ASSERTION_A, TOKEN_A)
    expect(answer.status).toBe(204)
    expect(readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_A))).toBe(TOKEN_A)
    expect(logs.filter(line => line.type === 'error')).toEqual([{
      name: 'auth-gate',
      type: 'error',
      text: 'a customer credential subscriber threw; the change it was told about is kept',
    }])
    expectNothingQuoted([answer], logs)
  })

  it('keeps the method, same-site, and JSON fences ahead of placing the member', async () => {
    // No directory: a fence that ran after placement would answer 503 here.
    const { ctx } = await loadComposition({})
    expect((await fetch(`${origin(ctx)}${AUTH_GATE_TOKEN_ROUTE}`)).status).toBe(405)
    expect((await post(ctx, AUTH_GATE_TOKEN_ROUTE, ASSERTION_A, '{}', { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post(ctx, AUTH_GATE_TOKEN_ROUTE, ASSERTION_A, '{}', { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await fetch(`${origin(ctx)}${AUTH_GATE_LOGOUT_ROUTE}`)).status).toBe(405)
    expect((await post(ctx, AUTH_GATE_LOGOUT_ROUTE, ASSERTION_A, undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post(ctx, AUTH_GATE_LOGOUT_ROUTE, ASSERTION_A, undefined, { 'content-type': 'text/plain' })).status).toBe(415)
  })
})

describe('per-member sign-out route', () => {
  it('drops the token of the member who sent it and no other', async () => {
    const { ctx } = await loadComposition({ members: MEMBERS, gate: { shareWithMemberDirectory: true } })
    await postToken(ctx, ASSERTION_A, TOKEN_A)
    await postToken(ctx, ASSERTION_B, TOKEN_B)
    const answer = await postLogout(ctx, ASSERTION_B)
    expect({ status: answer.status, body: answer.body }).toEqual({ status: 204, body: '' })
    expect(readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_A))).toBe(TOKEN_A)
    expect(readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_B))).toBeUndefined()
  })

  it('answers 401 for a sign-out it places with nobody, and drops nothing', async () => {
    const { ctx, logs } = await loadComposition({ members: MEMBERS, gate: { shareWithMemberDirectory: true } })
    await postToken(ctx, ASSERTION_A, TOKEN_A)
    const answers = [await postLogout(ctx, undefined), await postLogout(ctx, ASSERTION_NOBODY)]
    for (const answer of answers) {
      expect({ status: answer.status, body: documentOf(answer) }).toEqual({
        status: 401,
        body: { error: 'auth-gate: the sign-out route could not tell which member sent this request' },
      })
    }
    expect(readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_A))).toBe(TOKEN_A)
    expectNothingQuoted(answers, logs)
  })
})

describe('per-member data backend', () => {
  it('spends each session\'s owner\'s token, drops only the refused member\'s, and survives the other member signing out', async () => {
    backend = await startBackend()
    const { ctx, logs } = await loadComposition({
      members: MEMBERS,
      gate: { shareWithMemberDirectory: true },
      bizUpstream: backend.base,
    })
    const service = backendOf(ctx)
    const signal = new AbortController().signal
    const answers: Answer[] = []

    // Both members post, and both tokens are held at once.
    answers.push(await postToken(ctx, ASSERTION_A, TOKEN_A), await postToken(ctx, ASSERTION_B, TOKEN_B))
    expect(answers.map(answer => answer.status)).toEqual([204, 204])
    expect([readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_A)), readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_B))])
      .toEqual([TOKEN_A, TOKEN_B])

    // A's session, its child, and its grandchild present A's token; B's presents B's.
    for (const id of ['session-a', 'session-a-child', 'session-a-grandchild', 'session-b']) {
      expect(await service.userRights(session(id), signal)).toEqual({ resclass: [], rows: [] })
    }
    expect(backend.presented).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_A}`, `Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`])
    // A child the directory places with nobody reads nothing, and sends nothing.
    expect(await service.userRights(session('session-orphan'), signal)).toEqual({ kind: 'unauthenticated' })
    expect(backend.presented).toHaveLength(4)

    // The backend refuses B's token: only B's is dropped.
    backend.refused.add(TOKEN_B)
    expect(await service.userRights(session('session-b'), signal)).toEqual({ kind: 'refused', status: 401 })
    expect([service.holdsCredential(session('session-a')), service.holdsCredential(session('session-b'))]).toEqual([true, false])
    expect(await service.userRights(session('session-a'), signal)).toEqual({ resclass: [], rows: [] })
    expect(backend.presented.at(-1)).toBe(`Bearer ${TOKEN_A}`)

    // B signs in again and then out: A is untouched throughout.
    answers.push(await postToken(ctx, ASSERTION_B, TOKEN_B_AGAIN))
    expect(service.holdsCredential(session('session-b'))).toBe(true)
    answers.push(await postLogout(ctx, ASSERTION_B))
    expect([service.holdsCredential(session('session-a')), service.holdsCredential(session('session-b'))]).toEqual([true, false])
    expect(await service.userRights(session('session-a-child'), signal)).toEqual({ resclass: [], rows: [] })
    expect(backend.presented.at(-1)).toBe(`Bearer ${TOKEN_A}`)

    // B's page posts a token naming A: refused, and neither member's slot moves.
    const crossed = await postToken(ctx, ASSERTION_B, TOKEN_A_RENEWED)
    answers.push(crossed)
    expect(crossed.status).toBe(409)
    expect([readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_A)), readerOf(ctx).read(brandString<PrincipalKey>(MEMBER_B))])
      .toEqual([TOKEN_A, undefined])

    expectNothingQuoted(answers, logs)
  })

  it('places a browser request by asking the directory', async () => {
    backend = await startBackend()
    const { ctx } = await loadComposition({ members: MEMBERS, bizUpstream: backend.base })
    const service = backendOf(ctx)
    const placed = new IncomingMessage(new Socket())
    placed.headers[MEMBER_HEADER] = ASSERTION_B
    expect(service.subjectOfRequest(placed)).toEqual(member(MEMBER_B))
    expect(service.subjectOfRequest(new IncomingMessage(new Socket()))).toBeUndefined()
  })
})

describe('per-member holding without a member directory', () => {
  it('answers 503 naming the missing service, reads nothing, and logs it once the composition has loaded', async () => {
    backend = await startBackend()
    const { ctx, logs } = await loadComposition({ gate: { shareWithMemberDirectory: true }, bizUpstream: backend.base })
    await vi.waitFor(() => { expect(logs.filter(line => line.type === 'error')).toHaveLength(1) })
    expect(logs.filter(line => line.type === 'error')).toEqual([{
      name: 'auth-gate',
      type: 'error',
      text: 'perMember is set and no consoleMembers service is running now that the composition has loaded; the token and sign-out routes answer 503 until one is',
    }])

    const answers = [await postToken(ctx, ASSERTION_A, TOKEN_A), await postLogout(ctx, ASSERTION_A)]
    expect(answers.map(answer => ({ status: answer.status, body: documentOf(answer) }))).toEqual([
      { status: 503, body: { error: 'auth-gate: the token route needs the consoleMembers service, which is not running' } },
      { status: 503, body: { error: 'auth-gate: the sign-out route needs the consoleMembers service, which is not running' } },
    ])
    // No slot is shared by the process to fall back on: every read is unauthenticated, and nothing is sent.
    const service = backendOf(ctx)
    expect(await service.userRights(member(MEMBER_A), new AbortController().signal)).toEqual({ kind: 'unauthenticated' })
    expect(service.subjectOfRequest(new IncomingMessage(new Socket()))).toBeUndefined()
    expect(backend.presented).toEqual([])
    expectNothingQuoted(answers, logs)
  })

  it('logs nothing about a directory that is running', async () => {
    const { ctx, logs } = await loadComposition({ members: MEMBERS })
    await ctx.loader.await()
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(logs.filter(line => line.type === 'error')).toEqual([])
  })
})

describe('customer credential reader', () => {
  it('lends the directory nothing unless the row says so', async () => {
    const { ctx } = await loadComposition({ members: MEMBERS })
    expect(directoryOf(ctx).offered).toEqual([])
    // The routes hold tokens all the same.
    expect((await postToken(ctx, ASSERTION_A, TOKEN_A)).status).toBe(204)
  })

  it('lends the directory one reader when the row says so', async () => {
    const { ctx } = await loadComposition({ members: MEMBERS, gate: { shareWithMemberDirectory: true } })
    const directory = directoryOf(ctx)
    expect([directory.attaches, directory.releases, directory.offered.length]).toEqual([1, 0, 1])
  })

  it('shuts the token route when the directory refuses the reader, and logs it without a value', async () => {
    const { ctx, logs } = await loadComposition({
      members: { requests: MEMBERS.requests, sessions: MEMBERS.sessions, parents: MEMBERS.parents, refuseReader: true },
      gate: { shareWithMemberDirectory: true },
    })
    await vi.waitFor(() => { expect(logs.filter(line => line.type === 'error')).toHaveLength(1) })
    expect(logs.filter(line => line.type === 'error')).toEqual([{
      name: 'auth-gate',
      type: 'error',
      text: 'the consoleMembers service refused the customer credential reader; the token route answers 503 until that service is replaced',
    }])
    const answers = [await postToken(ctx, ASSERTION_A, TOKEN_A)]
    expect({ status: answers[0]!.status, body: documentOf(answers[0]!) }).toEqual({
      status: 503,
      body: { error: 'auth-gate: the token route takes no token while the consoleMembers service refuses the customer credential reader' },
    })
    // Signing out drops nothing the directory could miss, so it still answers.
    answers.push(await postLogout(ctx, ASSERTION_A))
    expect(answers[1]!.status).toBe(204)
    expectNothingQuoted(answers, logs)
  })

  it('takes the reader back from a directory that stops, and lends a new one to its successor', async () => {
    const { ctx } = await loadComposition({ members: MEMBERS, gate: { shareWithMemberDirectory: true } })
    await postToken(ctx, ASSERTION_A, TOKEN_A)
    const first = directoryOf(ctx)
    const lent = readerOf(ctx)
    expect(lent.read(brandString<PrincipalKey>(MEMBER_A))).toBe(TOKEN_A)

    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'console-members')
    await row?.fiber?.dispose()
    expect([first.attaches, first.releases]).toEqual([1, 1])
    // The released reader is revoked: the directory that stopped keeps no live view.
    expect(lent.read(brandString<PrincipalKey>(MEMBER_A))).toBeUndefined()
    expect((await postToken(ctx, ASSERTION_A, TOKEN_A_RENEWED)).status).toBe(503)

    const successor = new ConsoleMembersFixture(MEMBERS)
    ctx.plugin({ name: 'console-members-successor', apply: (scope: Context) => { scope.provide('consoleMembers', successor) } })
    await vi.waitFor(() => { expect(successor.attaches).toBe(1) })
    // The token held before the swap is still held, and the new reader reads it.
    expect(successor.reader?.read(brandString<PrincipalKey>(MEMBER_A))).toBe(TOKEN_A)
    expect(successor.reader).not.toBe(lent)
  })

  it('releases every route and takes the reader back when the fiber disposes (HMR safety)', async () => {
    const { ctx } = await loadComposition({ members: MEMBERS, gate: { shareWithMemberDirectory: true } })
    await postToken(ctx, ASSERTION_A, TOKEN_A)
    const directory = directoryOf(ctx)
    const lent = readerOf(ctx)
    const base = origin(ctx)
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'auth-gate')
    await row?.fiber?.dispose()
    expect([directory.attaches, directory.releases, directory.reader]).toEqual([1, 1, undefined])
    expect(lent.read(brandString<PrincipalKey>(MEMBER_A))).toBeUndefined()
    for (const path of [AUTH_GATE_SETTINGS_ROUTE, AUTH_GATE_TOKEN_ROUTE, AUTH_GATE_LOGOUT_ROUTE]) {
      // The webserver's own fallback answers a path nobody claims.
      const answer = await fetch(`${base}${path}`)
      expect({ path, status: answer.status }).toEqual({ path, status: 404 })
      await answer.arrayBuffer()
    }
  })
})
