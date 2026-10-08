/** Member Peer admission: the installed admitter decides every HTTP and upgrade request after Connection's own checks. */
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

/** The four ways a request reaches Host code: shared-channel interceptor, dedicated channel, exact Fetch route, upgrade. */
type ProbePath = 'interceptor' | 'channel' | 'exact' | 'upgrade'

interface Mounted {
  readonly ctx: Context
  readonly connectionFiber: ReturnType<Context['plugin']>
  /** Peers each probe handler received, in arrival order. */
  readonly seen: Array<{ readonly path: ProbePath; readonly peer: PeerScope }>
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

async function mount(config?: ConnectionConfig): Promise<Mounted> {
  const ctx = new Context()
  roots.push(ctx)
  const errors: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => { if (message.type === 'error') errors.push(String(message.args[0])) },
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  const connectionFiber = ctx.plugin({ inject: [...inject], apply }, config)
  await connectionFiber
  // Stands in for the deployment's route guard: with member admission on, an unguarded exact route or channel answers 503.
  ctx.on('connection/fetch', (_call, next) => next())
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
    fetch: async (_request, peer) => {
      seen.push({ path: 'exact', peer })
      return new Response('exact')
    },
  })
  // The Gateway's upgrade route admits through the same call before binding a socket to the Peer.
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: PROBE_UPGRADE,
    handler: (req, socket) => {
      const admission = ctx.connection.admit(req)
      if ('peer' in admission) seen.push({ path: 'upgrade', peer: admission.peer })
      const status = 'peer' in admission ? 204 : admission.rejection
      socket.end(`HTTP/1.1 ${String(status)} Probe\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    },
  }), 'peer-admission spec: upgrade probe')
  return { ctx, connectionFiber, seen, errors, port: ctx.webServer.port, cookie: browserCookie(ctx) }
}

/** Exchange the process token for the loopback authority's Cookie header. */
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
    interceptor: await send(mounted.port, `${API_PATH}/${PROBE_ENDPOINT}`, 'POST', json, JSON.stringify(envelope)),
    channel: await send(mounted.port, `${PROBE_CHANNEL}/${PROBE_ENDPOINT}`, 'POST', json, JSON.stringify(envelope)),
    exact: await send(mounted.port, PROBE_EXACT, 'GET', headers),
    upgrade: await upgrade(mounted.port, headers),
  }
}

function send(port: number, path: string, method: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      response.resume()
      response.on('end', () => { resolve(response.statusCode ?? 0) })
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

const ALL_OK: Record<ProbePath, number> = { interceptor: 200, channel: 200, exact: 200, upgrade: 204 }
const ALL_UNAUTHORIZED: Record<ProbePath, number> = { interceptor: 401, channel: 401, exact: 401, upgrade: 401 }

function trustRequest(mounted: Mounted): ConnectionTrustRequest {
  return { headers: { host: `127.0.0.1:${String(mounted.port)}`, cookie: mounted.cookie } }
}

describe('Connection member Peer admission', () => {
  it('admits every path as the operator while no admitter is installed', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx

    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_OK)
    expect(mounted.seen.map(entry => entry.path)).toEqual(['interceptor', 'channel', 'exact', 'upgrade'])
    for (const entry of mounted.seen) expect(entry.peer).toBe(connection.operator)
    expect(connection.requestRejection(trustRequest(mounted))).toBeUndefined()
    // A carrier that dispatches the shared handler directly, naming no Peer, also speaks for the operator.
    const direct = await connection.createSharedFetchHandler(API_PATH).fetch(new Request(`http://127.0.0.1${PROBE_EXACT}`))
    expect(direct.status).toBe(200)
    expect(mounted.seen.at(-1)?.peer).toBe(connection.operator)
    expect(connection.peers.list()).toEqual([])
    expect(connection.peers.requireAdmitter).toBe(false)
    expect(mounted.errors).toEqual([])
  })

  it('hands the admitted member Peer to every path and to requestRejection callers', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    const member = connection.peers.open()
    const admitter = vi.fn<PeerAdmitter>(() => member)
    connection.peers.admitWith(admitter)

    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_OK)
    expect(mounted.seen.map(entry => entry.path)).toEqual(['interceptor', 'channel', 'exact', 'upgrade'])
    for (const entry of mounted.seen) expect(entry.peer).toBe(member)
    expect(admitter).toHaveBeenCalledTimes(4)
    expect(connection.admit(trustRequest(mounted))).toEqual({ peer: member })
    expect(connection.requestRejection(trustRequest(mounted))).toBeUndefined()
    expect(connection.peers.get(member.id)).toBe(member)
    expect(connection.peers.list()).toEqual([member])
    expect(connection.peers.get(connection.operator.id)).toBeUndefined()
  })

  it('refuses with 401 and calls no handler when the admitter names no member', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    connection.peers.admitWith(() => undefined)

    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_UNAUTHORIZED)
    expect(mounted.seen).toEqual([])
    expect(connection.requestRejection(trustRequest(mounted))).toBe(401)
    expect(connection.admit(trustRequest(mounted))).toEqual({ rejection: 401 })
    expect(mounted.errors).toHaveLength(6)
    expect(mounted.errors[0]).toContain('named no member')
  })

  it('passes the admitter refusal status through', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    let verdict: 401 | 403 = 403
    connection.peers.admitWith(() => verdict)

    expect(await probeAll(mounted, { cookie: mounted.cookie }))
      .toEqual({ interceptor: 403, channel: 403, exact: 403, upgrade: 403 })
    expect(connection.requestRejection(trustRequest(mounted))).toBe(403)
    verdict = 401
    expect(connection.requestRejection(trustRequest(mounted))).toBe(401)
    expect(mounted.seen).toEqual([])
    expect(mounted.errors).toEqual([])
  })

  it('runs the Host/Origin checks and browser authentication before the admitter', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    const member = connection.peers.open()
    const admitter = vi.fn<PeerAdmitter>(() => member)
    connection.peers.admitWith(admitter)

    expect(await probeAll(mounted, { host: 'other.example', cookie: mounted.cookie }))
      .toEqual({ interceptor: 403, channel: 403, exact: 403, upgrade: 403 })
    expect(connection.requestRejection({ headers: { host: 'other.example', cookie: mounted.cookie } })).toBe(403)
    expect(await probeAll(mounted, {})).toEqual(ALL_UNAUTHORIZED)
    expect(connection.requestRejection({ headers: { host: `127.0.0.1:${String(mounted.port)}` } })).toBe(401)
    expect(admitter).not.toHaveBeenCalled()
    expect(mounted.seen).toEqual([])
  })

  it('refuses a released Peer, the operator, and a Peer it did not open with 401', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    const released = connection.peers.open()
    const live = connection.peers.open()
    // Same id and scope as a live member, but not the object open() returned.
    const impostor: PeerScope = { id: live.id, ctx: live.ctx, dispose: () => live.dispose() }
    let returned: PeerScope = released
    connection.peers.admitWith(() => returned)

    const disposing = released.dispose()
    expect(connection.peers.get(released.id)).toBeUndefined()
    expect(connection.peers.list()).toEqual([live])
    expect(connection.admit(trustRequest(mounted))).toEqual({ rejection: 401 })
    await disposing
    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_UNAUTHORIZED)
    returned = connection.operator
    expect(connection.admit(trustRequest(mounted))).toEqual({ rejection: 401 })
    returned = impostor
    expect(connection.admit(trustRequest(mounted))).toEqual({ rejection: 401 })
    returned = live
    expect(connection.admit(trustRequest(mounted))).toEqual({ peer: live })
    expect(mounted.seen).toEqual([])
    expect(mounted.errors.at(-1)).toContain('did not open or that is released')
  })

  it('accepts one admitter at a time and removes it with its registration', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    const member = ctx.connection.peers.open()
    const remove = ctx.connection.peers.admitWith(() => member)
    expect(() => ctx.connection.peers.admitWith(() => undefined)).toThrow('a Peer admitter is already installed')
    expect(ctx.connection.admit(trustRequest(mounted))).toEqual({ peer: member })
    await remove()
    expect(ctx.connection.admit(trustRequest(mounted))).toEqual({ peer: ctx.connection.operator })

    const owner = ctx.plugin({
      inject: ['connection'],
      apply: (pluginCtx: Context) => { pluginCtx.connection.peers.admitWith(() => member) },
    })
    await owner
    expect(ctx.connection.admit(trustRequest(mounted))).toEqual({ peer: member })
    await owner.dispose()
    expect(ctx.connection.admit(trustRequest(mounted))).toEqual({ peer: ctx.connection.operator })
  })

  it('validates requireAdmitter as a boolean that defaults to false', () => {
    expect(Config({}).requireAdmitter).toBe(false)
    expect(Config({ requireAdmitter: true }).requireAdmitter).toBe(true)
    expect(() => Config({ requireAdmitter: 'yes' } as never)).toThrow()
  })

  it('refuses every path with 401 while requireAdmitter is set and no admitter is installed', async () => {
    const mounted = await mount({ requireAdmitter: true })
    const { ctx } = mounted
    const { connection } = ctx
    expect(connection.peers.requireAdmitter).toBe(true)
    // Index authorization still accepts the browser cookie.
    const index = { method: 'GET', url: '/', headers: trustRequest(mounted).headers }
    expect(connection.authorizeIndex(index, { writeHead() {}, end() {} })).toBe(true)

    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_UNAUTHORIZED)
    expect(connection.requestRejection(trustRequest(mounted))).toBe(401)
    expect(connection.admit(trustRequest(mounted))).toEqual({ rejection: 401 })
    expect(await probeAll(mounted, { host: 'other.example', cookie: mounted.cookie }))
      .toEqual({ interceptor: 403, channel: 403, exact: 403, upgrade: 403 })
    expect(mounted.seen).toEqual([])

    const member = connection.peers.open()
    const remove = connection.peers.admitWith(() => member)
    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_OK)
    expect(mounted.seen.map(entry => entry.peer)).toEqual([member, member, member, member])
    await remove()
    expect(await probeAll(mounted, { cookie: mounted.cookie })).toEqual(ALL_UNAUTHORIZED)
    expect(connection.requestRejection(trustRequest(mounted))).toBe(401)

    const owner = ctx.plugin({
      inject: ['connection'],
      apply: (pluginCtx: Context) => { pluginCtx.connection.peers.admitWith(() => member) },
    })
    await owner
    expect(connection.admit(trustRequest(mounted))).toEqual({ peer: member })
    await owner.dispose()
    expect(connection.admit(trustRequest(mounted))).toEqual({ rejection: 401 })
    expect(mounted.seen).toHaveLength(4)
    expect(mounted.errors).toEqual([])
  })

  it('emits one opened and one closed event per member Peer, the closed one after its scope is released, and none for the operator', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    let scopeReleased = false
    const events: Array<{
      readonly kind: 'opened' | 'closed'
      readonly peer: PeerScope
      readonly listed: boolean
      readonly scopeReleased: boolean
    }> = []
    ctx.on('connection/peer-opened', (peer) => {
      events.push({ kind: 'opened', peer, listed: ctx.connection.peers.get(peer.id) === peer, scopeReleased })
    })
    ctx.on('connection/peer-closed', (peer) => {
      events.push({ kind: 'closed', peer, listed: ctx.connection.peers.get(peer.id) === peer, scopeReleased })
    })

    const member = ctx.connection.peers.open()
    expect(events).toEqual([{ kind: 'opened', peer: member, listed: true, scopeReleased: false }])
    member.ctx.effect(() => () => { scopeReleased = true }, 'peer-admission spec: member registration')
    await Promise.all([member.dispose(), member.dispose(), member.dispose()])
    await member.dispose()
    expect(events).toEqual([
      { kind: 'opened', peer: member, listed: true, scopeReleased: false },
      { kind: 'closed', peer: member, listed: false, scopeReleased: true },
    ])

    await ctx.connection.operator.dispose()
    expect(events).toHaveLength(2)
  })

  it('closes every open member Peer when Connection unloads', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    const closed: PeerScope[] = []
    ctx.on('connection/peer-closed', (peer) => { closed.push(peer) })
    const first = ctx.connection.peers.open()
    const second = ctx.connection.peers.open()
    await second.dispose()

    await mounted.connectionFiber.dispose()
    expect(closed).toEqual([second, first])
  })

  it('logs a throwing lifecycle listener instead of failing open() or dispose()', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    ctx.on('connection/peer-opened', () => { throw new Error('fixture opened listener') })
    ctx.on('connection/peer-closed', () => { throw new Error('fixture closed listener') })

    const member = ctx.connection.peers.open()
    expect(ctx.connection.peers.list()).toEqual([member])
    await expect(member.dispose()).resolves.toBeUndefined()
    expect(mounted.errors).toEqual([
      'client-connection: a connection/peer-opened listener threw',
      'client-connection: a connection/peer-closed listener threw',
    ])
  })

  it('reports member admission on while an admitter is installed or requireAdmitter is set, read at each access', async () => {
    const open = await mount()
    const peers = open.ctx.connection.peers
    expect(peers.memberAdmission).toBe(false)
    const remove = peers.admitWith(() => undefined)
    expect(peers.memberAdmission).toBe(true)
    await remove()
    expect(peers.memberAdmission).toBe(false)

    const required = await mount({ requireAdmitter: true })
    expect(required.ctx.connection.peers.memberAdmission).toBe(true)
  })

  describe('refuses with 401, without running the target, a request whose member Peer is released after admission', () => {
    const UPLOAD = `${API_PATH}/peer.upload`
    const envelope: ClientRequest = { type: 'client-request', rpcId: RpcId('probe'), method: PROBE_ENDPOINT, payload: {} }

    /** Mount with a buffered POST exact route and a member admitter; returns the member. */
    interface MemberMount {
      readonly mounted: Mounted
      readonly member: PeerScope
      readonly admitter: ReturnType<typeof vi.fn<PeerAdmitter>>
    }

    async function mountMember(): Promise<MemberMount> {
      const mounted = await mount()
      mounted.ctx.connection.fetch.register({
        path: UPLOAD,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (_request, peer) => {
          mounted.seen.push({ path: 'exact', peer })
          return new Response('uploaded')
        },
      })
      const member = mounted.ctx.connection.peers.open()
      const admitter = vi.fn<PeerAdmitter>(() => member)
      mounted.ctx.connection.peers.admitWith(admitter)
      return { mounted, member, admitter }
    }

    /** Send the first half of a POST body, then the rest once `finish()` is called. */
    function startPartial(
      port: number,
      path: string,
      cookie: string,
      body: string,
    ): { readonly status: Promise<number>; readonly finish: () => void } {
      let request!: ReturnType<typeof httpRequest>
      const status = new Promise<number>((resolve, reject) => {
        request = httpRequest({
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        }, (response) => {
          response.resume()
          response.on('end', () => { resolve(response.statusCode ?? 0) })
        })
        request.on('error', reject)
      })
      const half = Math.floor(body.length / 2)
      request.write(body.slice(0, half))
      return { status, finish: () => { request.end(body.slice(half)) } }
    }

    it.each([
      { path: 'exact', url: UPLOAD, body: JSON.stringify({ fill: 'x'.repeat(4096) }) },
      { path: 'channel', url: `${PROBE_CHANNEL}/${PROBE_ENDPOINT}`, body: JSON.stringify(envelope) },
      { path: 'interceptor', url: `${API_PATH}/${PROBE_ENDPOINT}`, body: JSON.stringify(envelope) },
    ] as const)('$path: released while the bridge buffers the body', async ({ url, body }) => {
      const { mounted, member, admitter } = await mountMember()
      const pending = startPartial(mounted.port, url, mounted.cookie, body)
      await vi.waitFor(() => { expect(admitter).toHaveBeenCalledTimes(1) })
      await member.dispose()
      pending.finish()

      expect(await pending.status).toBe(401)
      expect(mounted.seen).toEqual([])
    })

    it('exact route: released while a connection/request listener awaits before next()', async () => {
      const { mounted, member } = await mountMember()
      mounted.ctx.on('connection/request', async (_request, _response, next) => {
        await member.dispose()
        await next()
      })

      expect(await send(mounted.port, UPLOAD, 'POST', { cookie: mounted.cookie, 'content-type': 'application/json' }, '{}')).toBe(401)
      expect(mounted.seen).toEqual([])
    })

    it.each([
      { path: 'exact', url: UPLOAD, body: '{}' },
      { path: 'channel', url: `${PROBE_CHANNEL}/${PROBE_ENDPOINT}`, body: JSON.stringify(envelope) },
    ] as const)('$path: released while a connection/fetch listener awaits before next()', async ({ url, body }) => {
      const { mounted, member } = await mountMember()
      const answers: number[] = []
      mounted.ctx.on('connection/fetch', async (_call, next) => {
        await member.dispose()
        const response = await next()
        answers.push(response.status)
        return response
      })

      expect(await send(mounted.port, url, 'POST', { cookie: mounted.cookie, 'content-type': 'application/json' }, body)).toBe(401)
      expect(answers).toEqual([401])
      expect(mounted.seen).toEqual([])
    })

    it('refuses a Peer that Connection did not create, with no admitter installed', async () => {
      const mounted = await mount()
      const member = mounted.ctx.connection.peers.open()
      // Same id as a live member, but not the object `peers.open()` returned.
      const foreign: PeerScope = { id: member.id, ctx: member.ctx, dispose: () => member.dispose() }
      const shared = mounted.ctx.connection.createSharedFetchHandler(API_PATH)
      const exact = await shared.fetch(new Request(`http://127.0.0.1${PROBE_EXACT}`), foreign)
      const intercepted = await shared.fetch(new Request(`http://127.0.0.1${API_PATH}/${PROBE_ENDPOINT}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope),
      }), foreign)

      expect([exact.status, intercepted.status]).toEqual([401, 401])
      expect(mounted.seen).toEqual([])
      expect(mounted.ctx.connection.peers.memberAdmission).toBe(false)
    })

    it('refuses a Peer carrying the operator\'s id and scope that is not connection.operator', async () => {
      const mounted = await mount()
      const { connection } = mounted.ctx
      const forged: PeerScope = { id: connection.operator.id, ctx: connection.operator.ctx, dispose: () => connection.operator.dispose() }
      const shared = connection.createSharedFetchHandler(API_PATH)
      const exact = await shared.fetch(new Request(`http://127.0.0.1${PROBE_EXACT}`), forged)
      const intercepted = await shared.fetch(new Request(`http://127.0.0.1${API_PATH}/${PROBE_ENDPOINT}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope),
      }), forged)

      expect([exact.status, intercepted.status]).toEqual([401, 401])
      expect(mounted.seen).toEqual([])
      expect(connection.peers.memberAdmission).toBe(false)
    })

    it('lets a live member and the operator through on the same paths', async () => {
      const { mounted, member } = await mountMember()
      const headers = { cookie: mounted.cookie, 'content-type': 'application/json' }
      expect(await send(mounted.port, UPLOAD, 'POST', headers, '{}')).toBe(200)
      expect(await send(mounted.port, `${PROBE_CHANNEL}/${PROBE_ENDPOINT}`, 'POST', headers, JSON.stringify(envelope))).toBe(200)
      expect(await send(mounted.port, `${API_PATH}/${PROBE_ENDPOINT}`, 'POST', headers, JSON.stringify(envelope))).toBe(200)
      expect(mounted.seen.map(entry => entry.peer)).toEqual([member, member, member])
      // A shell-owned carrier naming no Peer speaks for the operator, which Connection releases only when it unloads.
      const direct = await mounted.ctx.connection.createSharedFetchHandler(API_PATH)
        .fetch(new Request(`http://127.0.0.1${UPLOAD}`, { method: 'POST', body: '{}' }))
      expect(direct.status).toBe(200)
      expect(mounted.seen.at(-1)?.peer).toBe(mounted.ctx.connection.operator)
    })
  })
})
