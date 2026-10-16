/** Peer admission: an installed admitter decides every authenticated HTTP and upgrade request after Connection's own checks. */
import { request as httpRequest } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API_PATH,
  Config,
  RpcId,
  apply,
  inject,
  type ClientRequest,
  type ConnectionConfig,
  type ConnectionTrustRequest,
  type PeerAdmitter,
  type PeerScope,
} from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller of the Connection admission specs. */
    'connection-test-member': { readonly kind: 'connection-test-member'; readonly member: string }
  }
}

/** The four ways a request reaches Host code: shared-channel interceptor, dedicated channel, exact Fetch route, upgrade. */
type ProbePath = 'interceptor' | 'channel' | 'exact' | 'upgrade'

interface Mounted {
  readonly ctx: Context
  /** Peers each probe handler received, in arrival order; an exact route receives none. */
  readonly seen: Array<{ readonly path: ProbePath; readonly peer: PeerScope | undefined }>
  /** `error`-level log lines written while the root is mounted. */
  readonly errors: string[]
  readonly port: number
  readonly cookie: string
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

const PROBE_CHANNEL = '/probe-rpc'
const PROBE_ENDPOINT = 'peer/check'
const PROBE_EXACT = `${API_PATH}/peer.exact`
const PROBE_UPGRADE = '/probe.upgrade'
const SECRET_COOKIE_VALUE = 'cookie-value-that-must-not-be-logged'

async function mount(config?: ConnectionConfig): Promise<Mounted> {
  const ctx = new Context()
  roots.push(ctx)
  const errors: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => { if (message.type === 'error') errors.push(message.args.map(String).join(' ')) },
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin({ inject: [...inject], apply }, config)
  const seen: Mounted['seen'][number][] = []
  const answer = async (path: ProbePath, peer: PeerScope): Promise<{ ok: true; value: null }> => {
    seen.push({ path, peer })
    return { ok: true, value: null }
  }
  ctx.connection.rpc.intercept(API_PATH, endpoint => endpoint === PROBE_ENDPOINT,
    (_endpoint, _payload, _signal, peer) => answer('interceptor', peer))
  ctx.connection.rpc.handle(PROBE_CHANNEL, (_endpoint, _payload, _signal, peer) => answer('channel', peer))
  ctx.connection.fetch.register({
    path: PROBE_EXACT,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      seen.push({ path: 'exact', peer: undefined })
      return new Response('exact')
    },
  })
  // Gateway's upgrade route admits through the same call before binding a socket to the Peer.
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: PROBE_UPGRADE,
    handler: (req, socket) => {
      const admission = ctx.connection.admit(req)
      if ('peer' in admission) seen.push({ path: 'upgrade', peer: admission.peer })
      const status = 'peer' in admission ? 204 : admission.rejection
      socket.end(`HTTP/1.1 ${String(status)} Probe\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    },
  }), 'peer-admission spec: upgrade probe')
  const port = ctx.webServer.port
  if (port === undefined) throw new Error('peer-admission fixture has no listening port')
  return { ctx, seen, errors, port, cookie: browserCookie(ctx) }
}

/** Exchange the process token for the loopback authority's browser Cookie header. */
function browserCookie(ctx: Context): string {
  const target = new URL(ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`))
  let setCookie: string | undefined
  ctx.connection.authorizeIndex(
    { method: 'GET', url: `${target.pathname}${target.search}`, headers: { host: target.host } },
    { writeHead(_status, headers) { setCookie = headers?.['set-cookie'] }, end() {} },
  )
  if (setCookie === undefined) throw new Error('peer-admission fixture did not receive a browser cookie')
  return setCookie.split(';', 1)[0]!
}

/** Send one real request on each of the four paths; returns the status each answered with. */
async function probeAll(mounted: Mounted, headers: Record<string, string>): Promise<Record<ProbePath, number>> {
  const envelope: ClientRequest = {
    type: 'client-request',
    rpcId: RpcId('probe'),
    method: PROBE_ENDPOINT,
    payload: {},
  }
  const json = { ...headers, 'content-type': 'application/json' }
  return {
    interceptor: (await send(mounted.port, `${API_PATH}/${PROBE_ENDPOINT}`, 'POST', json, JSON.stringify(envelope))).status,
    channel: (await send(mounted.port, `${PROBE_CHANNEL}/${PROBE_ENDPOINT}`, 'POST', json, JSON.stringify(envelope))).status,
    exact: (await send(mounted.port, PROBE_EXACT, 'GET', headers)).status,
    upgrade: await upgrade(mounted.port, headers),
  }
}

function send(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ readonly status: number; readonly setCookie: readonly string[]; readonly location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      response.resume()
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          setCookie: response.headers['set-cookie'] ?? [],
          location: response.headers.location,
        })
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

function upgrade(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: PROBE_UPGRADE,
      headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket' },
    })
    request.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('error', reject)
    request.end()
  })
}

/** Exchange the process launch token at `/connect` for an API Cookie header, as an API caller does. */
async function apiCookie(mounted: Mounted): Promise<string> {
  const target = new URL(mounted.ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(mounted.port)}/connect`))
  const connected = await send(mounted.port, `${target.pathname}${target.search}`, 'GET', {})
  expect(connected.status).toBe(302)
  expect(connected.location).toBe('./api/remote.mux')
  const cookie = connected.setCookie[0]?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('peer-admission fixture did not receive an API cookie')
  return cookie
}

const ALL_OK: Record<ProbePath, number> = { interceptor: 200, channel: 200, exact: 200, upgrade: 204 }
const ALL_UNAUTHORIZED: Record<ProbePath, number> = { interceptor: 401, channel: 401, exact: 401, upgrade: 401 }
const ALL_FORBIDDEN: Record<ProbePath, number> = { interceptor: 403, channel: 403, exact: 403, upgrade: 403 }
/** A non-owner Peer reaches the interceptor, channels, and upgrades; the shared handler refuses it the exact route. */
const MEMBER_OK: Record<ProbePath, number> = { interceptor: 200, channel: 200, exact: 403, upgrade: 204 }

function trustRequest(mounted: Mounted, cookie = mounted.cookie): ConnectionTrustRequest {
  return { headers: { host: `127.0.0.1:${String(mounted.port)}`, cookie } }
}

function member(mounted: Mounted, name: string): PeerScope {
  return mounted.ctx.connection.createPeer({ principal: { kind: 'connection-test-member', member: name } })
}

/** The API credential records `/connect` published and Connection still holds, oldest first. */
function apiRecords(mounted: Mounted): ReadonlyArray<{ readonly peer: PeerScope }> {
  // The records are private; their count is the resource the bound limits.
  const records = Reflect.get(mounted.ctx.connection, 'apiPeers') as ReadonlyMap<string, { readonly peer: PeerScope }>
  return [...records.values()]
}

async function apiCookies(mounted: Mounted, count: number): Promise<string[]> {
  const cookies: string[] = []
  for (let index = 0; index < count; index += 1) cookies.push(await apiCookie(mounted))
  return cookies
}

describe('Connection Peer admission', () => {
  it('admits every path as browserPeer while no admitter is installed', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx

    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_OK)
    expect(mounted.seen.map(entry => [entry.path, entry.peer])).toEqual([
      ['interceptor', connection.browserPeer], ['channel', connection.browserPeer], ['exact', undefined], ['upgrade', connection.browserPeer],
    ])
    expect(connection.requestRejection(trustRequest(mounted))).toBeUndefined()
    expect(connection.peers.requireAdmitter).toBe(false)
    expect(mounted.errors).toEqual([])
  })

  it('hands the Peer the admitter returns to every path and refuses it the exact route and requestRejection', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    const alice = member(mounted, 'alice')
    const admitter = vi.fn<PeerAdmitter>(() => alice)
    connection.peers.admitWith(admitter)

    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(MEMBER_OK)
    expect(mounted.seen.map(entry => entry.path)).toEqual(['interceptor', 'channel', 'upgrade'])
    for (const entry of mounted.seen) expect(entry.peer).toBe(alice)
    expect(admitter).toHaveBeenCalledTimes(4)
    expect(connection.admit(trustRequest(mounted))).toEqual({ peer: alice })
    // Routes gated by requestRejection bypass every access check, so a non-owner Peer is refused there.
    expect(connection.requestRejection(trustRequest(mounted))).toBe(403)
  })

  it('admits an owner Peer the admitter maps the operator to on every path', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    const operator = connection.createPeer({ principal: { kind: 'owner' } })
    connection.peers.admitWith(() => operator)

    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_OK)
    expect(mounted.seen.map(entry => entry.peer)).toEqual([operator, operator, undefined, operator])
    expect(connection.requestRejection(trustRequest(mounted))).toBeUndefined()
  })

  it('refuses with 401 and logs without header values when the admitter returns no Peer or a disposed one', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    const released = member(mounted, 'released')
    await released.dispose()
    let returned: PeerScope | undefined = undefined
    connection.peers.admitWith(() => returned)
    const headers = { cookie: `${mounted.cookie}; other=${SECRET_COOKIE_VALUE}` }

    expect(await probeAll(mounted, headers)).toEqual(ALL_UNAUTHORIZED)
    expect(connection.requestRejection(trustRequest(mounted))).toBe(401)
    expect(mounted.errors[0]).toContain('named no Peer')
    returned = released
    expect(connection.admit(trustRequest(mounted))).toEqual({ rejection: 401 })
    expect(mounted.errors.at(-1)).toContain('returned a disposed Peer')
    expect(mounted.seen).toEqual([])
    expect(mounted.errors.join('\n')).not.toContain(SECRET_COOKIE_VALUE)
    expect(mounted.errors.join('\n')).not.toContain(mounted.cookie.split('=', 2)[1]!)
  })

  it('refuses every authenticated path with 401 and logs without header values when the admitter throws', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    // The thrown message quotes the request headers, as a parse failure in an admitter can.
    connection.peers.admitWith((request) => { throw new SyntaxError(`unreadable identity in ${JSON.stringify(request.headers)}`) })
    const headers = { cookie: `${mounted.cookie}; other=${SECRET_COOKIE_VALUE}` }

    expect(await probeAll(mounted, headers)).toEqual(ALL_UNAUTHORIZED)
    expect(mounted.seen).toEqual([])
    expect(mounted.errors).toHaveLength(4)
    for (const error of mounted.errors) expect(error).toBe('client-connection: the Peer admitter threw SyntaxError; refusing the request with 401')
  })

  it('answers requestRejection 401 when the admitter throws', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    connection.peers.admitWith(() => { throw new Error(`admitter failed on ${SECRET_COOKIE_VALUE}`) })

    expect(connection.requestRejection(trustRequest(mounted))).toBe(401)
    expect(connection.admitConnection(trustRequest(mounted))).toEqual({ rejection: 401 })
    expect(mounted.errors.join('\n')).not.toContain(SECRET_COOKIE_VALUE)
    expect(mounted.errors[0]).toBe('client-connection: the Peer admitter threw Error; refusing the request with 401')
  })

  it('passes the admitter refusal status through', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    let verdict: 401 | 403 = 403
    connection.peers.admitWith(() => verdict)

    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_FORBIDDEN)
    expect(connection.requestRejection(trustRequest(mounted))).toBe(403)
    verdict = 401
    expect(connection.requestRejection(trustRequest(mounted))).toBe(401)
    expect(mounted.seen).toEqual([])
    expect(mounted.errors).toEqual([])
  })

  it('runs the Host/Origin checks and authentication before the admitter', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    const admitter = vi.fn<PeerAdmitter>(() => member(mounted, 'alice'))
    connection.peers.admitWith(admitter)

    expect(await probeAll(mounted, { host: 'other.example', cookie: mounted.cookie })).toEqual(ALL_FORBIDDEN)
    expect(connection.requestRejection({ headers: { host: 'other.example', cookie: mounted.cookie } })).toBe(403)
    expect(await probeAll(mounted, {})).toEqual(ALL_UNAUTHORIZED)
    expect(await probeAll(mounted, { cookie: 'dsh-forged=1' })).toEqual(ALL_UNAUTHORIZED)
    expect(connection.requestRejection({ headers: { host: `127.0.0.1:${String(mounted.port)}` } })).toBe(401)
    expect(admitter).not.toHaveBeenCalled()
    expect(mounted.seen).toEqual([])
  })

  it('sends the API Cookie that /connect exchanged for the launch token through the admitter too', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    const cookie = await apiCookie(mounted)
    // Without an admitter the API Cookie is an owner API Peer, so it is a valid credential.
    const apiAdmission = connection.admit(trustRequest(mounted, cookie))
    expect('peer' in apiAdmission && apiAdmission.peer.principal).toEqual({ kind: 'owner' })

    const admitter = vi.fn<PeerAdmitter>(() => undefined)
    const remove = connection.peers.admitWith(admitter)
    expect(await probeAll(mounted, { cookie })).toEqual(ALL_UNAUTHORIZED)
    expect(connection.admit(trustRequest(mounted, cookie))).toEqual({ rejection: 401 })
    expect(connection.admitConnection(trustRequest(mounted, cookie))).toEqual({ rejection: 401 })
    expect(connection.requestRejection(trustRequest(mounted, cookie))).toBe(401)
    expect(admitter).toHaveBeenCalledTimes(7)

    // A fresh /connect exchange while the admitter refuses still yields no owner admission.
    const fresh = await apiCookie(mounted)
    expect(connection.admit(trustRequest(mounted, fresh))).toEqual({ rejection: 401 })
    expect(mounted.seen).toEqual([])

    await remove()
    const alice = member(mounted, 'alice')
    connection.peers.admitWith(() => alice)
    expect(await probeAll(mounted, { cookie: fresh })).toEqual(MEMBER_OK)
    for (const entry of mounted.seen) expect(entry.peer).toBe(alice)
    const socket = connection.admitConnection(trustRequest(mounted, fresh))
    expect('peer' in socket && socket.peer).toBe(alice)
  })

  it('accepts one admitter at a time and removes it with its registration', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    const alice = member(mounted, 'alice')
    const remove = ctx.connection.peers.admitWith(() => alice)
    expect(() => ctx.connection.peers.admitWith(() => undefined)).toThrow('a Peer admitter is already installed')
    expect(ctx.connection.admit(trustRequest(mounted))).toEqual({ peer: alice })
    await remove()
    expect(ctx.connection.admit(trustRequest(mounted))).toEqual({ peer: ctx.connection.browserPeer })

    const owner = ctx.plugin({
      inject: ['connection'],
      apply: (pluginCtx: Context) => { pluginCtx.connection.peers.admitWith(() => alice) },
    })
    await owner
    expect(ctx.connection.admit(trustRequest(mounted))).toEqual({ peer: alice })
    await owner.dispose()
    expect(ctx.connection.admit(trustRequest(mounted))).toEqual({ peer: ctx.connection.browserPeer })
  })

  it('validates requireAdmitter as a boolean that defaults to false', () => {
    expect(Config({}).requireAdmitter).toBe(false)
    expect(Config({ requireAdmitter: true }).requireAdmitter).toBe(true)
    expect(() => Config({ requireAdmitter: 'yes' } as never)).toThrow()
  })

  it('validates maxUnclaimedApiPeers as a positive integer that defaults to 64', () => {
    expect(Config({}).maxUnclaimedApiPeers).toBe(64)
    expect(Config({ maxUnclaimedApiPeers: 1 }).maxUnclaimedApiPeers).toBe(1)
    for (const invalid of [0, 1.5, -1]) expect(() => Config({ maxUnclaimedApiPeers: invalid })).toThrow()
  })

  it('claims the API Cookie a socket presents under an admitter and ends that credential with the socket', async () => {
    const mounted = await mount({ requireAdmitter: true })
    const { connection } = mounted.ctx
    const alice = member(mounted, 'alice')
    connection.peers.admitWith(() => alice)
    const cookie = await apiCookie(mounted)
    const [record] = apiRecords(mounted)

    const socket = connection.admitConnection(trustRequest(mounted, cookie))
    if (!('peer' in socket)) throw new Error('the admitter admits the socket')
    expect(socket.peer).toBe(alice)
    const second = connection.admitConnection(trustRequest(mounted, cookie))
    expect('rejection' in second && second.rejection).toBe(409)
    expect(connection.admit(trustRequest(mounted, cookie))).toEqual({ peer: alice })

    await socket.release()
    expect(connection.admit(trustRequest(mounted, cookie))).toEqual({ rejection: 401 })
    expect(apiRecords(mounted)).toEqual([])
    expect(record!.peer.signal.aborted).toBe(true)
    // The member Peer belongs to the admitter, not to the credential.
    expect(alice.signal.aborted).toBe(false)
  })

  it('keeps at most maxUnclaimedApiPeers API Cookies without a socket while requireAdmitter is set or an admitter decides', async () => {
    const mounted = await mount({ requireAdmitter: true, maxUnclaimedApiPeers: 4 })
    const { connection } = mounted.ctx
    const early = await apiCookies(mounted, 6)
    const retired = apiRecords(mounted)[0]!
    expect(apiRecords(mounted)).toHaveLength(4)
    expect(retired.peer.signal.aborted).toBe(false)

    const alice = member(mounted, 'alice')
    connection.peers.admitWith(() => alice)
    const cookies = await apiCookies(mounted, 25)
    expect(apiRecords(mounted)).toHaveLength(4)
    expect(retired.peer.signal.aborted).toBe(true)
    for (const cookie of [...early, ...cookies.slice(0, 21)]) {
      expect(connection.admit(trustRequest(mounted, cookie))).toEqual({ rejection: 401 })
    }
    for (const cookie of cookies.slice(21)) expect(connection.admit(trustRequest(mounted, cookie))).toEqual({ peer: alice })

    // A credential a socket claimed is not retired by later exchanges.
    const newest = cookies.at(-1)
    if (newest === undefined) throw new Error('the fixture exchanged 25 API Cookies')
    const claimed = connection.admitConnection(trustRequest(mounted, newest))
    expect('peer' in claimed && claimed.peer).toBe(alice)
    await apiCookies(mounted, 4)
    expect(apiRecords(mounted)).toHaveLength(5)
    expect(connection.admit(trustRequest(mounted, newest))).toEqual({ peer: alice })
  })

  it('keeps every API Cookie /connect exchanged while no admitter is installed and requireAdmitter is unset', async () => {
    const mounted = await mount({ maxUnclaimedApiPeers: 2 })
    const { connection } = mounted.ctx
    const cookies = await apiCookies(mounted, 5)
    expect(apiRecords(mounted)).toHaveLength(5)
    for (const cookie of cookies) {
      const admission = connection.admit(trustRequest(mounted, cookie))
      expect('peer' in admission && admission.peer.principal).toEqual({ kind: 'owner' })
    }
    const [oldest] = cookies
    if (oldest === undefined) throw new Error('the fixture exchanged 5 API Cookies')
    const socket = connection.admitConnection(trustRequest(mounted, oldest))
    if (!('peer' in socket)) throw new Error('the owner API Peer owns its socket')
    expect(socket.peer).toBe(apiRecords(mounted)[0]!.peer)
    const second = connection.admitConnection(trustRequest(mounted, oldest))
    expect('rejection' in second && second.rejection).toBe(409)
    await socket.release()
    expect(connection.admit(trustRequest(mounted, oldest))).toEqual({ rejection: 401 })
    expect(apiRecords(mounted)).toHaveLength(4)
  })

  it('refuses every authenticated path with 401 while requireAdmitter is set and no admitter is installed', async () => {
    const mounted = await mount({ requireAdmitter: true })
    const { ctx } = mounted
    const { connection } = ctx
    expect(connection.peers.requireAdmitter).toBe(true)
    // Index authorization still accepts the browser cookie, and /connect still exchanges the launch token.
    const index = { method: 'GET', url: '/', headers: trustRequest(mounted).headers }
    expect(connection.authorizeIndex(index, { writeHead() {}, end() {} })).toBe(true)
    const cookie = await apiCookie(mounted)

    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_UNAUTHORIZED)
    expect(await probeAll(mounted, { cookie })).toEqual(ALL_UNAUTHORIZED)
    expect(connection.requestRejection(trustRequest(mounted))).toBe(401)
    expect(connection.admit(trustRequest(mounted))).toEqual({ rejection: 401 })
    expect(connection.admitConnection(trustRequest(mounted, cookie))).toEqual({ rejection: 401 })
    expect(await probeAll(mounted, { host: 'other.example', cookie: mounted.cookie })).toEqual(ALL_FORBIDDEN)
    expect(mounted.seen).toEqual([])

    const alice = member(mounted, 'alice')
    const remove = connection.peers.admitWith(() => alice)
    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(MEMBER_OK)
    expect(mounted.seen.map(entry => entry.peer)).toEqual([alice, alice, alice])
    await remove()
    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_UNAUTHORIZED)

    const owner = ctx.plugin({
      inject: ['connection'],
      apply: (pluginCtx: Context) => { pluginCtx.connection.peers.admitWith(() => alice) },
    })
    await owner
    expect(connection.admit(trustRequest(mounted))).toEqual({ peer: alice })
    await owner.dispose()
    expect(connection.admit(trustRequest(mounted))).toEqual({ rejection: 401 })
    expect(mounted.seen).toHaveLength(3)
    expect(mounted.errors).toEqual([])
  })
})
