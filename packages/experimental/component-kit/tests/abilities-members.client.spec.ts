/**
 * REAL-composition coverage for the data page's ability route in a console
 * that serves several members: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver, the sign-on gate with `perMember` and
 * a data backend configured, the test-only `consoleMembers` row from
 * `fixtures/console-members.client.ts` where a case needs one, and this row.
 * The only other stand-in is the deployment's backend, a local server
 * answering the rights read for the one token it grants.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as AuthGate from '@deepseek-ai/dsh-experimental-auth-gate'
import * as ComponentKit from '../src/index.ts'
import { MEMBER_HEADER, type Config as FixtureConfig } from './fixtures/console-members.client.ts'

const MEMBERS_ROW = pathToFileURL(resolve(import.meta.dirname, 'fixtures/console-members.client.ts')).href

const MEMBER_A = 'member-a'
const MEMBER_B = 'member-b'
const ASSERTION_A = 'assertion-of-a'
const ASSERTION_B = 'assertion-of-b'
const ASSERTION_NOBODY = 'assertion-of-nobody'

/** Member A's token, its claim naming A; nothing else here reads its claims. */
const TOKEN_A = `aGVhZGVy.${Buffer.from(`{"login_uid":"${MEMBER_A}"}`, 'utf8').toString('base64url')}.c2ln`

/** The directory's tables: two members and no sessions, since the route places requests only. */
const MEMBERS: FixtureConfig = {
  requests: { [ASSERTION_A]: MEMBER_A, [ASSERTION_B]: MEMBER_B },
  sessions: {},
  parents: {},
}

/** The rights the fake backend answers A's token with: one model granted add. */
const USER_INFO = {
  code: 0,
  data: { auth: { resclass: [{ resclassenname: 'SpaceLayer', search: null, add: true, update: null, delete: null }], rows: [] } },
}

/** What the route answers a request it places with nobody. */
const NOBODY = { error: 'component-kit: this request names no signed-in person whose rights could be read' }

let world: string | undefined
let context: Context | undefined
let backend: Server | undefined
/** The `Authorization` header of every request the backend received. */
let presented: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (backend !== undefined) {
    const closing = backend
    await new Promise<void>((resolveClose) => {
      closing.closeAllConnections()
      closing.close(() => { resolveClose() })
    })
  }
  backend = undefined
  presented = []
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/**
 * Start the stand-in backend on an OS-assigned port.
 * @returns the base URL the gate's `bizUpstream` points at.
 */
async function startBackend(): Promise<string> {
  const server = createServer((req, res) => {
    presented.push(req.headers.authorization ?? '')
    if (req.url === '/ini-server/nrms-auth/api/auth/userinfo' && req.headers.authorization === `Bearer ${TOKEN_A}`) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(USER_INFO))
      return
    }
    res.writeHead(401)
    res.end()
  })
  backend = server
  await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/ini-server/`
}

/**
 * Write the composition and boot it through the real Loader.
 * @param members - the directory row's tables; absent leaves the row out.
 * @returns the booted context.
 */
async function loadComposition(members?: FixtureConfig): Promise<Context> {
  const bizUpstream = await startBackend()
  world = await mkdtemp(join(tmpdir(), 'dsh-component-kit-members-'))
  const configPath = join(world, 'cordis.yml')
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
        bizUpstream,
        perMember: true,
        principalClaim: 'login_uid',
      },
    },
    { id: 'component-kit', name: '@deepseek-ai/dsh-experimental-component-kit' },
    ...members === undefined ? [] : [{ id: 'console-members', name: MEMBERS_ROW, config: members }],
  ]
  // JSON is YAML, so the rows are written as the documents they are.
  await writeFile(configPath, `${JSON.stringify(rows, null, 2)}\n`)
  const ctx = context = new Context()
  ctx.baseUrl = `${pathToFileURL(world).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Without a Node internal loader the Loader imports bare names through this
  // test runner's module graph, which resolves workspace packages to `src`.
  ctx.loader.internal = undefined
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

/**
 * The composed server's origin.
 * @param ctx - the booted composition.
 * @returns the origin.
 */
function origin(ctx: Context): string {
  return `http://127.0.0.1:${String(ctx.webServer.port)}`
}

/**
 * Ask the composed row what one member may do on one table.
 * @param ctx - the booted composition.
 * @param assertion - what stands in for the member assertion; absent sends none.
 * @returns the status and the decoded answer.
 */
async function abilitiesAs(ctx: Context, assertion: string | undefined): Promise<{ status: number; body: unknown }> {
  const answer = await fetch(`${origin(ctx)}${ComponentKit.COMPONENT_KIT_ABILITIES_ROUTE}?meta=SpaceLayer`, {
    headers: assertion === undefined ? {} : { [MEMBER_HEADER]: assertion },
  })
  const body: unknown = await answer.json()
  return { status: answer.status, body }
}

describe('the ability route per member', () => {
  it('reads each member\'s own rights with that member\'s own token, and nobody\'s for a request it places with nobody', async () => {
    const ctx = await loadComposition(MEMBERS)
    const posted = await fetch(`${origin(ctx)}${AuthGate.AUTH_GATE_TOKEN_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [MEMBER_HEADER]: ASSERTION_A },
      body: JSON.stringify({ token: TOKEN_A }),
    })
    expect(posted.status).toBe(204)
    expect(await abilitiesAs(ctx, ASSERTION_A))
      .toEqual({ status: 200, body: { create: true, update: false, delete: false, import: true, export: true } })
    // B holds no token: every ability off, and B's request spends nobody's token.
    expect(await abilitiesAs(ctx, ASSERTION_B)).toEqual({ status: 200, body: ComponentKit.NO_ABILITIES })
    for (const assertion of [undefined, ASSERTION_NOBODY]) {
      expect({ assertion, ...await abilitiesAs(ctx, assertion) }).toEqual({ assertion, status: 401, body: NOBODY })
    }
    expect(presented).toEqual([`Bearer ${TOKEN_A}`])
  })

  it('places every request with nobody while no member directory is running, and reads nothing', async () => {
    const ctx = await loadComposition()
    expect(await abilitiesAs(ctx, ASSERTION_A)).toEqual({ status: 401, body: NOBODY })
    expect(presented).toEqual([])
  })
})
