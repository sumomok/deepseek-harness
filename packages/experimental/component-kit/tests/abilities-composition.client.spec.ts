/**
 * REAL-composition coverage for the data page's ability route: a test-only
 * cordis.yml booted through the vendored Loader mounts the webserver, the
 * sign-on gate with a data backend configured — which constructs the real
 * `ctx.bizBackend` and its rule table — and this row, and every case observes
 * the composed server over HTTP. The only stand-in is the deployment's backend,
 * a local server answering the rights read.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as AuthGate from '@deepseek-ai/dsh-experimental-auth-gate'
import * as ComponentKit from '../src/index.ts'

/** A JWT-shaped token; nothing here reads its claims. */
const TOKEN = 'aGVhZGVy.eyJzdWIiOiJ1LTEifQ.c2ln'

/** The rights the fake backend answers with: one model granted add, one granted nothing, and a profile beside them. */
const USER_INFO = {
  code: 0,
  data: {
    useraccount: 'zhangsan',
    auth: {
      resclass: [
        { resclassenname: 'SpaceLayer', search: null, add: true, update: null, delete: null, exp: null },
        { resclassenname: 'CITY', search: null, add: null, update: null, delete: null },
      ],
      rows: [],
    },
  },
}

let world: string | undefined
let context: Context | undefined
let backend: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (backend !== undefined) {
    const closing = backend
    await new Promise<void>((resolve) => {
      closing.closeAllConnections()
      closing.close(() => { resolve() })
    })
  }
  backend = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/**
 * Start the stand-in backend on an OS-assigned port.
 * @returns the base URL the gate's `bizUpstream` points at.
 */
async function startBackend(): Promise<string> {
  const server = createServer((req, res) => {
    const granted = req.headers.authorization === `Bearer ${TOKEN}`
    if (req.url === '/ini-server/nrms-auth/api/auth/userinfo' && granted) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(USER_INFO))
      return
    }
    res.writeHead(401)
    res.end()
  })
  backend = server
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/ini-server/`
}

/**
 * Write the composition and boot it through the real Loader.
 * @param exportRule - the `export` rule this deployment writes, where it writes one.
 * @returns the booted context.
 */
async function loadComposition(exportRule?: string): Promise<Context> {
  const bizUpstream = await startBackend()
  world = await mkdtemp(join(tmpdir(), 'dsh-component-kit-abilities-'))
  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: auth-gate',
    "  name: '@deepseek-ai/dsh-experimental-auth-gate'",
    '  config:',
    "    loginUrl: '/toy-proxy/toy-login/#/'",
    '    cookieName: accessToken',
    '    refreshMarginSeconds: 300',
    '    mcpUpstreams: {}',
    `    bizUpstream: '${bizUpstream}'`,
    ...exportRule === undefined ? [] : ['    bizOperationRules:', `      export: ${exportRule}`],
    '- id: component-kit',
    "  name: '@deepseek-ai/dsh-experimental-component-kit'",
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = `${pathToFileURL(world).href}/`
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-experimental-auth-gate', AuthGate],
    ['@deepseek-ai/dsh-experimental-component-kit', ComponentKit],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
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
 * Hand the gate the visitor's token, the way the browser half does.
 * @param ctx - the booted composition.
 */
async function signIn(ctx: Context): Promise<void> {
  const posted = await fetch(`${origin(ctx)}${AuthGate.AUTH_GATE_TOKEN_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  })
  expect(posted.status).toBe(204)
}

/**
 * Ask the composed row what the visitor may do on one table.
 * @param ctx - the booted composition.
 * @param meta - the table.
 * @returns the decoded answer.
 */
async function abilitiesOf(ctx: Context, meta: string): Promise<unknown> {
  const answer = await fetch(`${origin(ctx)}${ComponentKit.COMPONENT_KIT_ABILITIES_ROUTE}?meta=${meta}`)
  expect(answer.status).toBe(200)
  return answer.json()
}

describe('the composed ability route', () => {
  it('answers the visitor\'s rights as the gate\'s default rules judge them', async () => {
    const ctx = await loadComposition()
    await signIn(ctx)
    expect(await abilitiesOf(ctx, 'SpaceLayer')).toEqual({ create: true, update: false, delete: false, import: true, export: true })
    expect(await abilitiesOf(ctx, 'CITY')).toEqual({ create: false, update: false, delete: false, import: false, export: true })
    expect(await abilitiesOf(ctx, 'SITE')).toEqual(ComponentKit.NO_ABILITIES)
  })

  it('judges by the rule table the deployment wrote on the gate', async () => {
    const ctx = await loadComposition('[exp]')
    await signIn(ctx)
    expect(await abilitiesOf(ctx, 'SpaceLayer')).toEqual({ create: true, update: false, delete: false, import: true, export: false })
  })

  it('answers every ability off before anybody has signed in', async () => {
    const ctx = await loadComposition()
    expect(await abilitiesOf(ctx, 'SpaceLayer')).toEqual(ComponentKit.NO_ABILITIES)
  })
})
