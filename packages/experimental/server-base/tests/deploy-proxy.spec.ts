/**
 * Coverage for `deploy/proxy.mjs`, the deployment-layer login gate. The pure
 * functions are called directly; the two modes run as real servers on
 * loopback ports between a stand-in dsh process and a stand-in customer
 * system, which answers the renewal check and serves the remote application.
 *
 * The member assertion is checked by a verifier written here from the
 * documented format alone, so a change to the format fails these cases rather
 * than passing through a shared implementation.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import net from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { generateKeyPairSync, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASSERTION_LIFETIME_SECONDS,
  GATE_EXEMPT_EXACT,
  GATE_EXEMPT_PREFIXES,
  MEMBER_HEADER,
  claimsRefusal,
  createGate,
  createProxyServer,
  createVerifierServer,
  decodeClaims,
  forwardHeaders,
  headerCredential,
  inspectCredential,
  isGateExempt,
  isRemote,
  presentedCredential,
  readSettings,
  remoteResponseHeaders,
  requestFraming,
  requestPathname,
  signAssertion,
  verdictOf,
} from '../deploy/proxy.mjs'
import type { ClaimsPolicy, Gate } from '../deploy/proxy.mjs'

/** A 19-digit `login_uid`, past the range a JavaScript number holds exactly. */
const MEMBER = '1234567890123456789'
const OTHER_MEMBER = '1234567890123456790'
const DEPLOYMENT = 'deployment-test'
const KEY_FILE = 'assertion-key.pem'
const NO_CLAIMS_CHECKS: ClaimsPolicy = { expectedIss: undefined, allowedTenants: undefined, allowedAppIds: undefined }

const keys = generateKeyPairSync('ed25519')
const PRIVATE_PEM = keys.privateKey.export({ format: 'pem', type: 'pkcs8' })

/**
 * A JWT in the customer system's form, its payload written verbatim so a
 * numeric claim stays a JSON number of any length. The signature is never
 * checked by the gate.
 * @param payload - the payload JSON text.
 * @returns the bare token.
 */
function jwt(payload: string): string {
  return `${Buffer.from('{"alg":"HS512"}').toString('base64url')}.${Buffer.from(payload).toString('base64url')}.c2lnbmF0dXJl`
}

/**
 * A member token with the claims the cases read.
 * @param fields - claim overrides, as JSON member text.
 * @returns the bare token.
 */
function memberToken(fields: { uid?: string; jti?: string; extra?: string } = {}): string {
  const extra = fields.extra === undefined ? '' : `,${fields.extra}`
  return jwt(`{"sub":"alice","jti":"${fields.jti ?? 'jti-1'}","iss":"Inspur","tenants":"t1,t2","login_uid":${fields.uid ?? MEMBER},"login_app_id":42,"exp":4102444800${extra}}`)
}

const TOKEN = memberToken()

/**
 * Check an assertion the way a host-side verifier built from the documented
 * format would: `v1.<payload>.<signature>`, an Ed25519 signature over
 * `v1.<payload>`, and a payload of `p`, `aud`, and `exp`.
 * @param value - the header value.
 * @param publicKey - the deployment's public key.
 * @param deploymentId - the expected audience.
 * @param nowSeconds - the current time in Unix seconds.
 * @returns the member the assertion names, or undefined when it is refused.
 */
function verifyAssertion(value: string, publicKey: KeyObject, deploymentId: string, nowSeconds: number): string | undefined {
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return undefined
  const [version, payload, signature] = parts as [string, string, string]
  if (!verify(null, Buffer.from(`${version}.${payload}`, 'ascii'), publicKey, Buffer.from(signature, 'base64url'))) return undefined
  const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  if (typeof claims !== 'object' || claims === null || !('p' in claims) || !('aud' in claims) || !('exp' in claims)) return undefined
  if (typeof claims.p !== 'string' || claims.aud !== deploymentId || typeof claims.exp !== 'number') return undefined
  return claims.exp > nowSeconds ? claims.p : undefined
}

/**
 * Reads the one key file the cases configure.
 * @param path - the configured path.
 * @returns the PEM bytes.
 */
function readKeyFile(path: string): Buffer {
  if (path === KEY_FILE) return Buffer.from(PRIVATE_PEM)
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
}

/** One request a stand-in server received. */
interface Received {
  method: string
  path: string
  headers: IncomingHttpHeaders
  /** The whole request body; empty for an upgrade. */
  body: string
}

/** A stand-in server with what it received. */
interface Stub {
  server: http.Server
  port: number
  requests: Received[]
  upgrades: Received[]
}

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
})

/**
 * Listen on an ephemeral loopback port and register the server for teardown,
 * accepted and upgraded sockets included.
 * @param server - an unlistened server.
 * @param gate - the gate whose sockets close with it, if any.
 * @returns the port.
 */
async function listen(server: Server, gate?: Gate): Promise<number> {
  const sockets = new Set<Socket>()
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    gate?.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    })
  })
  return (server.address() as AddressInfo).port
}

/**
 * A stand-in server that records every request once its body has arrived, and
 * every upgrade, and answers 200 or 101; `answer` may claim a path first.
 * @param answer - answers a path itself and returns true, or returns false.
 * @returns the stub.
 */
async function stub(answer: (req: http.IncomingMessage, res: http.ServerResponse) => boolean = () => false): Promise<Stub> {
  const requests: Received[] = []
  const upgrades: Received[] = []
  const server = http.createServer((req, res) => {
    if (answer(req, res)) {
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('latin1') })
      res.end('ok')
    })
  })
  server.on('upgrade', (req, socket) => {
    upgrades.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: '' })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  return { server, port: await listen(server), requests, upgrades }
}

/** The renewal endpoint's answer to one presented credential. */
type Renewal = (authorization: string | undefined) => { status: number; body: string }

/** By default the endpoint answers 200 and hands back the presented token, scheme included, as the customer system does. */
const ECHO_RENEWAL: Renewal = authorization => ({ status: 200, body: JSON.stringify({ renewal: '3600000', token: authorization }) })

/** A running gate between the two stand-ins. */
interface World {
  port: number
  dsh: Stub
  customer: Stub
  renewals: () => number
  logs: string[]
  clock: { now: number }
}

/**
 * Start a stand-in dsh, a stand-in customer system, and the gate in the given
 * mode between them.
 * @param env - environment overrides; the signing key and deployment id are configured unless overridden.
 * @param renewal - the renewal endpoint's answers.
 * @returns the world.
 */
async function world(env: Record<string, string | undefined> = {}, renewal: Renewal = ECHO_RENEWAL): Promise<World> {
  let renewals = 0
  const customer = await stub((req, res) => {
    if (req.url !== '/nrms-auth/api/renewal') return false
    renewals += 1
    const reply = renewal(req.headers.authorization)
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(reply.body)
    return true
  })
  const dsh = await stub()
  const logs: string[] = []
  const clock = { now: 1_800_000_000_000 }
  const settings = readSettings({
    DSH_WEB_PORT: String(dsh.port),
    REMOTE_HOST: '127.0.0.1',
    REMOTE_PORT: String(customer.port),
    AUTH_ORIGIN: env.PROXY_MODE === 'verify' ? `http://127.0.0.1:${String(customer.port)}` : undefined,
    MEMBER_ASSERTION_KEY_FILE: KEY_FILE,
    MEMBER_ASSERTION_DEPLOYMENT_ID: DEPLOYMENT,
    ...env,
  }, readKeyFile)
  const runtime = { log: (line: string) => { logs.push(line) }, now: () => clock.now }
  const { server, gate } = settings.mode === 'verify' ? createVerifierServer(settings, runtime) : createProxyServer(settings, runtime)
  return { port: await listen(server, gate), dsh, customer, renewals: () => renewals, logs, clock }
}

/**
 * Send one request without connection reuse.
 * @param port - the gate's port.
 * @param path - the request target.
 * @param headers - request headers.
 * @returns the status and response headers.
 */
function send(port: number, path: string, headers: OutgoingHttpHeaders = {}): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, headers, agent: false }, (response) => {
      response.resume()
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers })
      })
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Send one WebSocket upgrade request.
 * @param port - the gate's port.
 * @param path - the request target.
 * @param headers - request headers.
 * @returns 101 when the handshake was switched, otherwise the refusal status.
 */
function upgrade(port: number, path: string, headers: OutgoingHttpHeaders = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, agent: false, headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } })
    request.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve(response.statusCode ?? 0)
    })
    request.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('error', reject)
    request.end()
  })
}

const LOGGED_IN = { 'cookie': `accessToken=${TOKEN}`, 'x-dsh-member': 'forged-by-the-client' }
const FORGED_ONLY = { 'x-dsh-member': 'forged-by-the-client' }

/**
 * The member header the last request a stub received carried.
 * @param received - a stub's recorded requests or upgrades.
 * @returns the header value, or undefined when it carried none.
 */
function lastMemberHeader(received: Received[]): string | string[] | undefined {
  return received.at(-1)?.headers[MEMBER_HEADER]
}

/**
 * The member a gate-signed header names, read as console-members would.
 * @param value - the forwarded header value.
 * @param clock - the world clock.
 * @param clock.now - the current time in milliseconds.
 * @returns the verified member, or undefined.
 */
function memberOf(value: string | string[] | undefined, clock: { now: number }): string | undefined {
  return typeof value === 'string' ? verifyAssertion(value, keys.publicKey, DEPLOYMENT, Math.floor(clock.now / 1000)) : undefined
}

/**
 * Write raw bytes to the gate and read its answer until the connection
 * closes. Raw, because Node's own client frames every body itself and would
 * hide how the gate frames one.
 * @param port - the gate's port.
 * @param text - the whole request text.
 * @returns everything the gate sent back, as latin1 text.
 */
function exchange(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = ''
    const client = net.connect(port, '127.0.0.1', () => { client.write(text) })
    closers.push(async () => { client.destroy() })
    client.on('data', (chunk: Buffer) => { received += chunk.toString('latin1') })
    client.on('end', () => { resolve(received) })
    client.on('error', reject)
  })
}

/**
 * Header names that read as the member header once lowercased with
 * underscores as hyphens.
 * @param headers - headers a stand-in received.
 * @returns the matching names.
 */
function memberHeaderNames(headers: IncomingHttpHeaders): string[] {
  return Object.keys(headers).filter(name => name.toLowerCase().replaceAll('_', '-') === MEMBER_HEADER)
}

/** A complete request a client hides in a body or after a handshake, naming a member of its own choosing. */
const SMUGGLED = 'GET /api/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nx-dsh-member: forged-by-the-client\r\n\r\n'
/** The member header in both spellings a client might send. */
const FORGED_LINES = 'X-Dsh-Member: forged-by-the-client\r\nX_Dsh_Member: forged-by-the-client\r\n'
/** Every method Node's parser accepts as an ordinary request; CONNECT is a tunnel and never reaches the request handler. */
const FORWARDED_METHODS = http.METHODS.filter(method => method !== 'CONNECT')

/**
 * The framing headers and body of a request carrying `body`.
 * @param framing - how the body is delimited; chunked splits it across two chunks.
 * @param body - the body text, ASCII.
 * @returns the text from the framing header through the end of the body.
 */
function framedBody(framing: 'content-length' | 'chunked', body: string): string {
  if (framing === 'content-length') return `Content-Length: ${String(body.length)}\r\n\r\n${body}`
  const chunk = (part: string) => `${part.length.toString(16)}\r\n${part}\r\n`
  const half = Math.floor(body.length / 2)
  return `Transfer-Encoding: chunked\r\n\r\n${chunk(body.slice(0, half))}${chunk(body.slice(half))}0\r\n\r\n`
}

/** A raw TCP stand-in for an upstream and everything one connection sent it. */
interface RawStub {
  port: number
  /** Resolves with the bytes received once the connection's sender ends it. */
  ended: Promise<string>
  /**
   * Resolves once the received bytes contain `text`.
   * @param text - the text to wait for.
   * @returns all bytes received so far.
   */
  until: (text: string) => Promise<string>
}

/**
 * An upstream that answers the first request head on a connection with
 * `reply`, or closes the connection when `reply` is undefined, then keeps the
 * connection open and records every byte. An HTTP server that answers an
 * upgrade with anything but 101 reads the bytes after it as further requests;
 * this stand-in shows what it would have read.
 * @param reply - the raw response to the first request head.
 * @returns the stub.
 */
async function rawStub(reply: string | undefined): Promise<RawStub> {
  let received = ''
  const ended = Promise.withResolvers<string>()
  const waiters: Array<{ text: string; resolve: (received: string) => void }> = []
  const server = net.createServer((connection) => {
    let answered = false
    connection.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1')
      for (const waiter of waiters.filter(entry => received.includes(entry.text))) waiter.resolve(received)
      if (answered || !received.includes('\r\n\r\n')) return
      answered = true
      if (reply === undefined) connection.destroy()
      else connection.write(reply)
    })
    connection.on('end', () => {
      ended.resolve(received)
      connection.end()
    })
    connection.on('error', () => { connection.destroy() })
  })
  const until = (text: string) => new Promise<string>((resolve) => {
    if (received.includes(text)) resolve(received)
    else waiters.push({ text, resolve })
  })
  return { port: await listen(server), ended: ended.promise, until }
}

/**
 * A proxy-mode gate in front of the given dsh and remote-application ports,
 * with a separate stand-in answering the renewal check.
 * @param dshPort - the stand-in dsh's port.
 * @param remotePort - the stand-in remote application's port.
 * @returns the gate's port and the lines it logged.
 */
async function gateBetween(dshPort: number, remotePort: number): Promise<{ port: number; logs: string[] }> {
  const renewal = await stub((req, res) => {
    res.end(JSON.stringify({ renewal: '3600000', token: req.headers.authorization }))
    return true
  })
  const settings = readSettings({
    DSH_WEB_PORT: String(dshPort),
    REMOTE_HOST: '127.0.0.1',
    REMOTE_PORT: String(remotePort),
    AUTH_ORIGIN: `http://127.0.0.1:${String(renewal.port)}`,
    MEMBER_ASSERTION_KEY_FILE: KEY_FILE,
    MEMBER_ASSERTION_DEPLOYMENT_ID: DEPLOYMENT,
  }, readKeyFile)
  const logs: string[] = []
  const { server, gate } = createProxyServer(settings, { log: (line) => { logs.push(line) }, now: () => 1_800_000_000_000 })
  return { port: await listen(server, gate), logs }
}

/**
 * A proxy-mode gate whose dsh and remote application are raw stand-ins
 * answering `reply`.
 * @param reply - what both raw stand-ins answer the handshake with.
 * @returns the gate's port and the two raw stand-ins.
 */
async function rawWorld(reply: string | undefined): Promise<{ port: number; dsh: RawStub; remote: RawStub }> {
  const dsh = await rawStub(reply)
  const remote = await rawStub(reply)
  const { port } = await gateBetween(dsh.port, remote.port)
  return { port, dsh, remote }
}

/** The one chunk a streaming stand-in writes after its response head. */
const FIRST_CHUNK = 'first-chunk'
/** What a flooding stand-in keeps writing after FIRST_CHUNK. */
const FLOOD_PIECE = Buffer.alloc(16 * 1024, 'x')

/**
 * How a streaming stand-in answers each request. `chunk` writes a 200 head
 * and FIRST_CHUNK and then holds the response open, as an idle event stream
 * does; `flood` writes the same and then keeps writing for as long as the
 * connection takes it; `silent` writes nothing, as a long poll that has
 * nothing to report does.
 */
type StreamingAnswer = 'chunk' | 'flood' | 'silent'

/** A stand-in upstream that never ends a response and answers every upgrade 101. */
interface StreamingStub {
  port: number
  /** The target of every upgrade handshake received. */
  upgrades: string[]
  /**
   * @param index - the request's position in arrival order, from 0.
   * @returns a promise that resolves once that request has arrived.
   */
  arrived: (index: number) => Promise<true>
  /**
   * @param index - the request's position in arrival order, from 0.
   * @returns a promise that resolves once the connection that carried that request closes.
   */
  closed: (index: number) => Promise<true>
}

/**
 * The resolvers kept for one request position, created on first use from
 * either side.
 * @param slots - the resolvers by position.
 * @param index - the position.
 * @returns the resolvers at `index`.
 */
function slot(slots: Map<number, PromiseWithResolvers<true>>, index: number): PromiseWithResolvers<true> {
  let entry = slots.get(index)
  if (entry === undefined) {
    entry = Promise.withResolvers<true>()
    slots.set(index, entry)
  }
  return entry
}

/**
 * A stand-in upstream that answers each request as `answer` says and each
 * upgrade with 101.
 * @param answer - how each request is answered.
 * @returns the stub.
 */
async function streamingStub(answer: StreamingAnswer): Promise<StreamingStub> {
  const arrivals = new Map<number, PromiseWithResolvers<true>>()
  const closes = new Map<number, PromiseWithResolvers<true>>()
  let count = 0
  const server = http.createServer((req, res) => {
    const index = count
    count += 1
    req.resume()
    req.socket.once('close', () => { slot(closes, index).resolve(true) })
    res.on('error', () => { res.destroy() })
    slot(arrivals, index).resolve(true)
    if (answer === 'silent') return
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(FIRST_CHUNK)
    if (answer === 'flood') {
      const flood = (): void => {
        let more = true
        while (more && !res.destroyed) more = res.write(FLOOD_PIECE)
        if (!res.destroyed) res.once('drain', flood)
      }
      flood()
    }
  })
  const upgrades: string[] = []
  server.on('upgrade', (req: http.IncomingMessage, socket: Socket) => {
    upgrades.push(req.url ?? '')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  return {
    port: await listen(server),
    upgrades,
    arrived: index => slot(arrivals, index).promise,
    closed: index => slot(closes, index).promise,
  }
}

/**
 * A proxy-mode gate whose dsh and remote application are streaming stand-ins.
 * @param answer - how both stand-ins answer each request.
 * @returns the gate's port, the lines it logged, and the two stand-ins.
 */
async function streamingWorld(answer: StreamingAnswer = 'chunk'): Promise<{ port: number; logs: string[]; dsh: StreamingStub; remote: StreamingStub }> {
  const dsh = await streamingStub(answer)
  const remote = await streamingStub(answer)
  return { ...(await gateBetween(dsh.port, remote.port)), dsh, remote }
}

/** An open raw connection to the gate. */
interface OpenConnection {
  client: Socket
  /** Everything the gate has sent so far, as latin1 text. */
  received: () => string
  /**
   * @param marker - the text to wait for in the answer.
   * @returns a promise that resolves once the answer contains `marker` and rejects when the connection closes first.
   */
  until: (marker: string) => Promise<true>
  /** Resolves once the connection closes. */
  closed: Promise<true>
}

/**
 * Open a raw connection, write `text`, and wait until the gate's answer
 * contains `marker`.
 * @param port - the gate's port.
 * @param text - the bytes sent first.
 * @param marker - the text to wait for in the answer.
 * @returns the still-open connection.
 * @throws {Error} when the connection closes before `marker` arrives.
 */
async function readUntil(port: number, text: string, marker: string): Promise<OpenConnection> {
  let received = ''
  let ended = false
  const waiters: Array<{ marker: string; reached: PromiseWithResolvers<true> }> = []
  const closed = Promise.withResolvers<true>()
  const client = net.connect(port, '127.0.0.1', () => { client.write(text) })
  closers.push(async () => { client.destroy() })
  const refusal = (wanted: string) => new Error(`connection closed before ${JSON.stringify(wanted)}: ${JSON.stringify(received)}`)
  client.on('data', (chunk: Buffer) => {
    received += chunk.toString('latin1')
    for (const waiter of waiters) if (received.includes(waiter.marker)) waiter.reached.resolve(true)
  })
  client.on('error', () => { client.destroy() })
  client.on('close', () => {
    ended = true
    for (const waiter of waiters) waiter.reached.reject(refusal(waiter.marker))
    closed.resolve(true)
  })
  const until = (wanted: string): Promise<true> => {
    const reached = Promise.withResolvers<true>()
    if (received.includes(wanted)) reached.resolve(true)
    else if (ended) reached.reject(refusal(wanted))
    else waiters.push({ marker: wanted, reached })
    return reached.promise
  }
  await until(marker)
  return { client, received: () => received, until, closed: closed.promise }
}

/**
 * A WebSocket handshake request head carrying the forged member headers.
 * @param path - the request target.
 * @param extra - further header lines, each ending in CRLF.
 * @returns the request head, ending in a blank line.
 */
function handshake(path: string, extra = ''): string {
  return `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: accessToken=${TOKEN}\r\n${FORGED_LINES}${extra}\r\n`
}

/**
 * A loopback port that was just released, so nothing listens on it.
 * @returns the port.
 */
async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })
  return port
}

/** A proxy-mode gate whose renewal check waits until released. */
interface HeldWorld {
  port: number
  dsh: Stub
  /** TCP connections the stand-in dsh accepted. */
  dshConnections: () => number
  logs: string[]
  /** Resolves once the first renewal check reaches the authentication service. */
  checking: Promise<true>
  /** Resolves with the gate's side of the first connection it accepts. */
  accepted: Promise<Socket>
  /** Answers every held renewal check, and every later one at once. */
  release: () => void
}

/**
 * Start a proxy-mode gate whose renewal answers are held until `release`,
 * between a stand-in dsh that counts its connections and that held service.
 * @returns the world.
 */
async function heldWorld(): Promise<HeldWorld> {
  const checking = Promise.withResolvers<true>()
  const held: Array<() => void> = []
  let released = false
  const renewal = http.createServer((req, res) => {
    req.resume()
    const answer = () => { res.end(JSON.stringify({ renewal: '3600000', token: req.headers.authorization })) }
    if (released) answer()
    else held.push(answer)
    checking.resolve(true)
  })
  const renewalPort = await listen(renewal)
  const dsh = await stub()
  let dshConnections = 0
  dsh.server.on('connection', () => { dshConnections += 1 })
  const settings = readSettings({
    DSH_WEB_PORT: String(dsh.port),
    REMOTE_HOST: '127.0.0.1',
    REMOTE_PORT: String(await closedPort()),
    AUTH_ORIGIN: `http://127.0.0.1:${String(renewalPort)}`,
  })
  const logs: string[] = []
  const { server, gate } = createProxyServer(settings, { log: (line) => { logs.push(line) }, now: () => 1_800_000_000_000 })
  const accepted = Promise.withResolvers<Socket>()
  server.on('connection', (socket: Socket) => { accepted.resolve(socket) })
  const port = await listen(server, gate)
  const release = () => {
    released = true
    for (const answer of held.splice(0)) answer()
  }
  return { port, dsh, dshConnections: () => dshConnections, logs, checking: checking.promise, accepted: accepted.promise, release }
}

/**
 * Open a raw connection, write `text`, then leave once the gate's renewal
 * check is in flight, and wait until the gate has closed its side.
 * @param w - the held world.
 * @param text - what the client sends before leaving.
 * @param leave - `end` sends FIN; `reset` sends RST.
 * @returns once the gate's side of the connection has closed.
 */
async function leaveDuringCheck(w: HeldWorld, text: string, leave: 'end' | 'reset'): Promise<void> {
  const client = net.connect(w.port, '127.0.0.1', () => { client.write(text) })
  closers.push(async () => { client.destroy() })
  client.on('data', () => {})
  client.on('error', () => { client.destroy() })
  await w.checking
  const gateSide = await w.accepted
  const closed = new Promise<void>((resolve) => { gateSide.once('close', () => { resolve() }) })
  if (leave === 'end') client.end()
  else client.resetAndDestroy()
  await closed
}

/**
 * Write raw bytes to the gate, end the client's side, and collect whatever
 * the gate sends back until the connection closes.
 * @param port - the gate's port.
 * @param text - the bytes sent before the client's FIN.
 * @returns everything the gate sent back, as latin1 text.
 */
function sendAndEnd(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = ''
    const client = net.connect(port, '127.0.0.1', () => { client.end(text) })
    closers.push(async () => { client.destroy() })
    client.on('data', (chunk: Buffer) => { received += chunk.toString('latin1') })
    client.on('close', () => { resolve(received) })
    client.on('error', reject)
  })
}

describe('configuration fails loud at start', () => {
  const base = { DSH_WEB_PORT: '3739', REMOTE_HOST: '127.0.0.1', REMOTE_PORT: '9532' }
  const ecKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' })

  it.each([
    [{}, /DSH_WEB_PORT/],
    [{ DSH_WEB_PORT: '3739' }, /REMOTE_HOST/],
    [{ ...base, REMOTE_PORT: 'nine' }, /REMOTE_PORT/],
    [{ ...base, PROXY_PORT: '0' }, /PROXY_PORT/],
    [{ ...base, PROXY_MODE: 'relay' }, /PROXY_MODE/],
    [{ ...base, LOGIN_GATE: 'maybe' }, /LOGIN_GATE/],
    [{ ...base, MEMBER_ASSERTION_KEY_FILE: KEY_FILE }, /needs MEMBER_ASSERTION_DEPLOYMENT_ID/],
    [{ ...base, MEMBER_ASSERTION_DEPLOYMENT_ID: DEPLOYMENT }, /MEMBER_ASSERTION_KEY_FILE is not/],
    [{ ...base, MEMBER_ASSERTION_KEY_FILE: KEY_FILE, MEMBER_ASSERTION_DEPLOYMENT_ID: DEPLOYMENT, LOGIN_GATE: 'off' }, /needs LOGIN_GATE=on/],
    [{ ...base, MEMBER_ASSERTION_KEY_FILE: 'missing.pem', MEMBER_ASSERTION_DEPLOYMENT_ID: DEPLOYMENT }, /readable PEM private key/],
    [{ PROXY_MODE: 'verify', LOGIN_GATE: 'off', AUTH_ORIGIN: 'http://127.0.0.1:9532' }, /PROXY_MODE=verify .*LOGIN_GATE=on/],
    [{ PROXY_MODE: 'verify' }, /AUTH_ORIGIN/],
    [{ ...base, AUTH_ORIGIN: 'http://127.0.0.1:9532/nrms-auth' }, /AUTH_ORIGIN must be an http or https origin/],
    [{ ...base, AUTH_ORIGIN: 'ftp://127.0.0.1' }, /AUTH_ORIGIN/],
    [{ ...base, AUTH_ORIGIN: 'http://user@127.0.0.1:9532' }, /AUTH_ORIGIN/],
    [{ ...base, AUTH_ORIGIN: 'http://:secret@127.0.0.1:9532' }, /AUTH_ORIGIN/],
    [{ ...base, REMOTE_HOST: '[::1]' }, /^proxy: REMOTE_HOST /],
    [{ ...base, REMOTE_HOST: 'remote.example/app' }, /^proxy: REMOTE_HOST /],
    [{ ...base, REMOTE_HOST: 'user@remote.example' }, /^proxy: REMOTE_HOST /],
    [{ ...base, AUTH_CA_FILE: KEY_FILE }, /AUTH_CA_FILE needs an https AUTH_ORIGIN/],
    [{ ...base, AUTH_CHECK_PATH: 'nrms-auth/api/renewal' }, /AUTH_CHECK_PATH/],
    [{ ...base, AUTH_CHECK_REPLY: 'body' }, /AUTH_CHECK_REPLY/],
    [{ ...base, ALLOWED_TENANTS: ' , ,' }, /ALLOWED_TENANTS is set but lists no value/],
    [{ ...base, AUTH_CACHE_SECONDS: '-1' }, /AUTH_CACHE_SECONDS/],
  ])('refuses %j', (env, message) => {
    expect(() => readSettings(env, readKeyFile)).toThrow(message)
  })

  it('refuses a signing key that is not Ed25519', () => {
    const env = { ...base, MEMBER_ASSERTION_KEY_FILE: 'ec.pem', MEMBER_ASSERTION_DEPLOYMENT_ID: DEPLOYMENT }
    expect(() => readSettings(env, () => Buffer.from(ecKey))).toThrow(/Ed25519/)
  })

  it('defaults to the gated proxy with no assertions and checks the renewal reply', () => {
    const settings = readSettings(base, readKeyFile)
    expect(settings).toMatchObject({
      mode: 'proxy',
      loginGate: true,
      listenHost: '127.0.0.1',
      listenPort: 8082,
      authCookie: 'accessToken',
      authCheckPath: '/nrms-auth/api/renewal',
      authCheckReply: 'renewal',
      authCacheSeconds: 30,
      assertion: undefined,
      claims: NO_CLAIMS_CHECKS,
    })
    expect(settings.authOrigin.href).toBe('http://127.0.0.1:9532/')
  })

  it('derives the default AUTH_ORIGIN from REMOTE_HOST and REMOTE_PORT, with an IPv6 address in brackets', () => {
    expect(readSettings({ ...base, REMOTE_HOST: '::1' }, readKeyFile).authOrigin.href).toBe('http://[::1]:9532/')
    expect(readSettings({ ...base, REMOTE_HOST: '::1', AUTH_ORIGIN: 'https://auth.example' }, readKeyFile).authOrigin.href).toBe('https://auth.example/')
  })
})

describe('routing', () => {
  it('classifies the pathname dsh will route, after resolving dot segments', () => {
    expect(requestPathname('/plugins/../api/rpc?x=1')).toBe('/api/rpc')
    expect(isRemote('/api/rpc')).toBe(false)
    expect(isGateExempt('/api/rpc')).toBe(false)
    expect(isRemote('/apis')).toBe(true)
    expect(isRemote('/ini-web2/index.html')).toBe(true)
    expect(isRemote('/open-in-app/apps')).toBe(false)
    expect(isRemote('/favicon-dark.svg')).toBe(false)
    expect(isGateExempt('/favicon-dark.svg')).toBe(true)
    expect(isGateExempt('/component-kit/settings')).toBe(true)
    expect(isGateExempt('/component-kit/data')).toBe(false)
  })

  it('exempts the same paths as the nginx template, whose prefix locations end in a slash', () => {
    const template = readFileSync(fileURLToPath(new URL('../deploy/nginx.console.conf', import.meta.url)), 'utf8')
    const exact: string[] = []
    const prefixes: string[] = []
    for (const [, equals, path] of template.matchAll(/^ *location (= )?\/console(\/\S*) +\{ auth_request off;/gm)) {
      if (equals === undefined) {
        expect(path).toMatch(/\/$/)
        prefixes.push(String(path).slice(0, -1))
      } else {
        exact.push(String(path))
      }
    }
    expect(new Set(exact)).toEqual(GATE_EXEMPT_EXACT)
    expect(prefixes).toEqual(GATE_EXEMPT_PREFIXES)
  })

  it('strips the framing and cookie attributes that block embedding the remote application', () => {
    expect(remoteResponseHeaders({
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'set-cookie': ['a=1; Secure; Domain=example.com; Path=/'],
      'connection': 'close',
      'content-type': 'text/html',
    })).toEqual({
      'content-security-policy': "default-src 'self'",
      'set-cookie': ['a=1; Path=/'],
      'content-type': 'text/html',
    })
  })
})

describe('header filtering', () => {
  it('removes the member header in any casing or underscore spelling and attaches only the given assertion', () => {
    const headers = { 'X-Dsh-Member': 'forged', 'x-dsh-member': 'forged', 'x_dsh_member': 'forged', 'X_Dsh-Member': 'forged', 'connection': 'keep-alive', 'accept': 'text/html' }
    expect(forwardHeaders(headers, undefined)).toEqual({ accept: 'text/html' })
    expect(forwardHeaders(headers, 'remote:1', 'v1.a.b')).toEqual({ 'accept': 'text/html', 'host': 'remote:1', 'x-dsh-member': 'v1.a.b' })
  })

  it('reads the mirror cookie and the Authorization header as Bearer credentials', () => {
    expect(presentedCredential(`a=1; accessToken=${TOKEN}`, 'accessToken')).toBe(`Bearer ${TOKEN}`)
    expect(presentedCredential(`accessToken=${encodeURIComponent(`Bearer ${TOKEN}`)}`, 'accessToken')).toBe(`Bearer ${TOKEN}`)
    expect(presentedCredential('accessToken=%E0%A4%A', 'accessToken')).toBeUndefined()
    expect(headerCredential('Bearer ')).toBeUndefined()
    expect(headerCredential(undefined)).toBeUndefined()
    expect(headerCredential(`Bearer ${TOKEN}`)).toBe(`Bearer ${TOKEN}`)
  })
})

describe('request framing', () => {
  it('reads the body framing the client declared', () => {
    expect(requestFraming({})).toEqual({ body: 'none' })
    expect(requestFraming({ 'content-length': '0' })).toEqual({ body: 'length', length: '0' })
    expect(requestFraming({ 'content-length': '12' })).toEqual({ body: 'length', length: '12' })
    expect(requestFraming({ 'transfer-encoding': 'chunked' })).toEqual({ body: 'chunked' })
    expect(requestFraming({ 'transfer-encoding': ' Chunked ' })).toEqual({ body: 'chunked' })
  })

  it('refuses framing that two parsers could read differently', () => {
    expect(requestFraming({ 'content-length': '5', 'transfer-encoding': 'chunked' })).toEqual({ body: 'refused', reason: 'content-length-and-transfer-encoding' })
    for (const coding of ['gzip', 'gzip, chunked', 'chunked, chunked', 'identity']) {
      expect(requestFraming({ 'transfer-encoding': coding })).toEqual({ body: 'refused', reason: 'transfer-encoding' })
    }
    expect(requestFraming({ 'content-length': '+5' })).toEqual({ body: 'refused', reason: 'content-length' })
  })
})

describe('verification result', () => {
  it('keeps a 19-digit numeric login_uid exact', () => {
    expect(decodeClaims(TOKEN)?.login_uid).toBe(MEMBER)
    expect(inspectCredential(`Bearer ${TOKEN}`, NO_CLAIMS_CHECKS)).toEqual({ ok: true, member: MEMBER, jti: 'jti-1' })
  })

  it('refuses a credential that names no member', () => {
    expect(inspectCredential('Bearer not-a-jwt', NO_CLAIMS_CHECKS)).toEqual({ ok: false, reason: 'undecodable' })
    expect(inspectCredential(`Bearer ${jwt('{"sub":"alice","jti":"j"}')}`, NO_CLAIMS_CHECKS)).toEqual({ ok: false, reason: 'no-member' })
    expect(inspectCredential(`Bearer ${jwt('[1]')}`, NO_CLAIMS_CHECKS)).toEqual({ ok: false, reason: 'undecodable' })
  })

  it('runs each claims check only when it is configured', () => {
    const credential = `Bearer ${memberToken({ extra: '"x":1' })}`
    expect(inspectCredential(credential, { ...NO_CLAIMS_CHECKS, expectedIss: 'Inspur' }).ok).toBe(true)
    expect(inspectCredential(credential, { ...NO_CLAIMS_CHECKS, expectedIss: 'Other' })).toEqual({ ok: false, reason: 'iss' })
    expect(inspectCredential(credential, { ...NO_CLAIMS_CHECKS, allowedTenants: ['t2'] }).ok).toBe(true)
    expect(inspectCredential(credential, { ...NO_CLAIMS_CHECKS, allowedTenants: ['t9'] })).toEqual({ ok: false, reason: 'tenants' })
    expect(inspectCredential(`Bearer ${jwt(`{"login_uid":${MEMBER},"tenants":["t3",7]}`)}`, { ...NO_CLAIMS_CHECKS, allowedTenants: ['7'] }).ok).toBe(true)
    expect(inspectCredential(credential, { ...NO_CLAIMS_CHECKS, allowedAppIds: ['42'] }).ok).toBe(true)
    expect(inspectCredential(credential, { ...NO_CLAIMS_CHECKS, allowedAppIds: ['7'] })).toEqual({ ok: false, reason: 'app-id' })
    expect(inspectCredential(`Bearer ${jwt(`{"login_uid":${MEMBER}}`)}`, { ...NO_CLAIMS_CHECKS, allowedAppIds: ['42'] })).toEqual({ ok: false, reason: 'app-id' })
  })

  it('names the failed claims check directly', () => {
    expect(claimsRefusal({ iss: 'Inspur', tenants: ['t1'], login_app_id: '42' }, { expectedIss: 'Inspur', allowedTenants: ['t1'], allowedAppIds: ['42'] })).toBeUndefined()
    expect(claimsRefusal({}, { ...NO_CLAIMS_CHECKS, allowedTenants: ['t1'] })).toBe('tenants')
  })

  it('admits on renewal only when the reply token carries the submitted login_uid and jti', () => {
    const identity = { member: MEMBER, jti: 'jti-1' }
    const reply = (token: string) => ({ status: 200, body: JSON.stringify({ renewal: '3600000', token }) })
    expect(verdictOf(reply(`Bearer ${TOKEN}`), identity, 'renewal')).toEqual({ outcome: 'admitted', member: MEMBER })
    expect(verdictOf(reply(memberToken({ jti: 'jti-2' })), identity, 'renewal')).toEqual({ outcome: 'refused', reason: 'reply-mismatch' })
    expect(verdictOf(reply(memberToken({ uid: OTHER_MEMBER })), identity, 'renewal')).toEqual({ outcome: 'refused', reason: 'reply-mismatch' })
    expect(verdictOf({ status: 200, body: '{"renewal":"3600000"}' }, identity, 'renewal')).toEqual({ outcome: 'refused', reason: 'reply-mismatch' })
    expect(verdictOf({ status: 200, body: 'not json' }, identity, 'renewal')).toEqual({ outcome: 'refused', reason: 'reply-mismatch' })
    expect(verdictOf(reply(`Bearer ${TOKEN}`), { member: MEMBER, jti: undefined }, 'renewal')).toEqual({ outcome: 'refused', reason: 'reply-mismatch' })
    expect(verdictOf({ status: 200, body: '' }, identity, 'status')).toEqual({ outcome: 'admitted', member: MEMBER })
    expect(verdictOf({ status: 401, body: '' }, identity, 'renewal')).toEqual({ outcome: 'refused', reason: 'service' })
    expect(verdictOf({ status: 403, body: '' }, identity, 'renewal')).toEqual({ outcome: 'refused', reason: 'service' })
    expect(verdictOf({ status: 502, body: '' }, identity, 'renewal')).toEqual({ outcome: 'unavailable', detail: '502' })
  })
})

describe('member assertion', () => {
  const now = 1_800_000_000

  it('verifies with the matching public key under the documented format', () => {
    const assertion = signAssertion(MEMBER, DEPLOYMENT, keys.privateKey, now)
    expect(assertion.startsWith('v1.')).toBe(true)
    expect(JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString('utf8'))).toEqual({ p: MEMBER, aud: DEPLOYMENT, exp: now + ASSERTION_LIFETIME_SECONDS })
    expect(verifyAssertion(assertion, keys.publicKey, DEPLOYMENT, now + ASSERTION_LIFETIME_SECONDS - 1)).toBe(MEMBER)
  })

  it('is refused once expired, under another audience, under another key, or altered', () => {
    const assertion = signAssertion(MEMBER, DEPLOYMENT, keys.privateKey, now)
    expect(verifyAssertion(assertion, keys.publicKey, DEPLOYMENT, now + ASSERTION_LIFETIME_SECONDS)).toBeUndefined()
    expect(verifyAssertion(assertion, keys.publicKey, 'another-deployment', now)).toBeUndefined()
    expect(verifyAssertion(assertion, generateKeyPairSync('ed25519').publicKey, DEPLOYMENT, now)).toBeUndefined()
    const [version, , signature] = assertion.split('.')
    const forgedPayload = Buffer.from(JSON.stringify({ p: OTHER_MEMBER, aud: DEPLOYMENT, exp: now + ASSERTION_LIFETIME_SECONDS })).toString('base64url')
    expect(verifyAssertion(`${String(version)}.${forgedPayload}.${String(signature)}`, keys.publicKey, DEPLOYMENT, now)).toBeUndefined()
  })
})

describe('proxy mode', () => {
  it('replaces a forged member header with a fresh assertion on a verified dsh request', async () => {
    const w = await world()
    expect((await send(w.port, '/api/rpc', LOGGED_IN)).status).toBe(200)
    const first = lastMemberHeader(w.dsh.requests)
    expect(first).not.toBe('forged-by-the-client')
    expect(memberOf(first, w.clock)).toBe(MEMBER)

    w.clock.now += 5_000
    expect((await send(w.port, '/api/rpc', LOGGED_IN)).status).toBe(200)
    const second = lastMemberHeader(w.dsh.requests)
    expect(second).not.toBe(first)
    expect(memberOf(second, w.clock)).toBe(MEMBER)
    expect(w.renewals()).toBe(1)
  })

  it('forwards an exempt path with the forged header removed and no assertion', async () => {
    const w = await world()
    for (const path of ['/', '/assets/index.js', '/plugins/x.js', '/auth-gate/settings', '/favicon-dark.svg']) {
      expect((await send(w.port, path, FORGED_ONLY)).status).toBe(200)
      expect(lastMemberHeader(w.dsh.requests)).toBeUndefined()
      expect((await send(w.port, path, LOGGED_IN)).status).toBe(200)
      expect(lastMemberHeader(w.dsh.requests)).toBeUndefined()
    }
    expect(w.renewals()).toBe(0)
  })

  it('gates a dot-segment path that resolves outside the exempt list', async () => {
    const w = await world()
    expect((await send(w.port, '/plugins/../api/rpc', FORGED_ONLY)).status).toBe(401)
    expect(w.dsh.requests).toHaveLength(0)
  })

  it('forwards a remote-application path with the forged header removed and no assertion', async () => {
    const w = await world()
    expect((await send(w.port, '/ini-web2/index.html', LOGGED_IN)).status).toBe(200)
    expect(w.customer.requests.at(-1)?.path).toBe('/ini-web2/index.html')
    expect(lastMemberHeader(w.customer.requests)).toBeUndefined()
    expect(w.renewals()).toBe(0)
  })

  it('attaches an assertion to a verified WebSocket upgrade and strips the forged header elsewhere', async () => {
    const w = await world()
    expect(await upgrade(w.port, '/api/remote.mux', LOGGED_IN)).toBe(101)
    expect(memberOf(lastMemberHeader(w.dsh.upgrades), w.clock)).toBe(MEMBER)

    expect(await upgrade(w.port, '/plugins/events', FORGED_ONLY)).toBe(101)
    expect(lastMemberHeader(w.dsh.upgrades)).toBeUndefined()

    expect(await upgrade(w.port, '/toy-proxy/socket', LOGGED_IN)).toBe(101)
    expect(lastMemberHeader(w.customer.upgrades)).toBeUndefined()

    expect(await upgrade(w.port, '/api/remote.mux', FORGED_ONLY)).toBe(401)
    expect(w.dsh.upgrades).toHaveLength(2)
  })

  it.each([
    ['jti', memberToken({ jti: 'jti-2' })],
    ['login_uid', memberToken({ uid: OTHER_MEMBER })],
  ])('refuses a login whose renewal reply carries another %s', async (_claim, replied) => {
    const w = await world({}, () => ({ status: 200, body: JSON.stringify({ renewal: '3600000', token: replied }) }))
    expect((await send(w.port, '/api/rpc', LOGGED_IN)).status).toBe(401)
    expect(await upgrade(w.port, '/api/remote.mux', LOGGED_IN)).toBe(401)
    expect(w.dsh.requests).toHaveLength(0)
    expect(w.dsh.upgrades).toHaveLength(0)
  })

  it('admits on status alone with AUTH_CHECK_REPLY=status', async () => {
    const w = await world({ AUTH_CHECK_REPLY: 'status' }, () => ({ status: 200, body: '{}' }))
    expect((await send(w.port, '/api/rpc', LOGGED_IN)).status).toBe(200)
    expect(memberOf(lastMemberHeader(w.dsh.requests), w.clock)).toBe(MEMBER)
  })

  it('refuses before asking the service when the token names no member or fails a claims check', async () => {
    const noMember = await world()
    expect((await send(noMember.port, '/api/rpc', { cookie: `accessToken=${jwt('{"sub":"alice","jti":"j"}')}` })).status).toBe(401)
    expect(noMember.renewals()).toBe(0)

    const otherIssuer = await world({ EXPECTED_ISS: 'Other' })
    expect((await send(otherIssuer.port, '/api/rpc', LOGGED_IN)).status).toBe(401)
    const otherApp = await world({ ALLOWED_APP_IDS: '7,8' })
    expect((await send(otherApp.port, '/api/rpc', LOGGED_IN)).status).toBe(401)
    expect(otherIssuer.renewals() + otherApp.renewals()).toBe(0)

    const allowed = await world({ EXPECTED_ISS: 'Inspur', ALLOWED_TENANTS: 't9, t2', ALLOWED_APP_IDS: '42' })
    expect((await send(allowed.port, '/api/rpc', LOGGED_IN)).status).toBe(200)
    expect(memberOf(lastMemberHeader(allowed.dsh.requests), allowed.clock)).toBe(MEMBER)
  })

  it('answers 401 to a refused login and 503 to an unavailable service', async () => {
    const refused = await world({}, () => ({ status: 401, body: '' }))
    expect((await send(refused.port, '/api/rpc', LOGGED_IN)).status).toBe(401)
    const down = await world({}, () => ({ status: 500, body: '' }))
    expect((await send(down.port, '/api/rpc', LOGGED_IN)).status).toBe(503)
    expect(refused.dsh.requests.length + down.dsh.requests.length).toBe(0)
  })

  it('only strips the header when no signing key is configured', async () => {
    const w = await world({ MEMBER_ASSERTION_KEY_FILE: undefined, MEMBER_ASSERTION_DEPLOYMENT_ID: undefined })
    expect((await send(w.port, '/api/rpc', LOGGED_IN)).status).toBe(200)
    expect(lastMemberHeader(w.dsh.requests)).toBeUndefined()
    expect(await upgrade(w.port, '/api/remote.mux', LOGGED_IN)).toBe(101)
    expect(lastMemberHeader(w.dsh.upgrades)).toBeUndefined()
  })

  it('forwards everything with the header stripped when the login gate is off', async () => {
    const w = await world({ LOGIN_GATE: 'off', MEMBER_ASSERTION_KEY_FILE: undefined, MEMBER_ASSERTION_DEPLOYMENT_ID: undefined })
    expect((await send(w.port, '/api/rpc', FORGED_ONLY)).status).toBe(200)
    expect(lastMemberHeader(w.dsh.requests)).toBeUndefined()
    expect(await upgrade(w.port, '/api/remote.mux', FORGED_ONLY)).toBe(101)
    expect(lastMemberHeader(w.dsh.upgrades)).toBeUndefined()
    expect(w.renewals()).toBe(0)
  })
})

describe('request bodies', () => {
  describe.each([
    ['a verified dsh path', '/api/rpc', 'dsh', true],
    ['an exempt dsh path', '/assets/upload', 'dsh', false],
    ['a remote-application path', '/ini-web2/upload', 'remote', false],
  ] as const)('on %s', (_label, path, target, signed) => {
    it.each(['content-length', 'chunked'] as const)('reach the upstream as exactly the body of their one request for every method, framed by %s', async (framing) => {
      const w = await world()
      const upstream = target === 'dsh' ? w.dsh : w.customer
      for (const method of FORWARDED_METHODS) {
        const before = upstream.requests.length
        const answer = await exchange(w.port, `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nCookie: accessToken=${TOKEN}\r\n${FORGED_LINES}${framedBody(framing, SMUGGLED)}`)
        expect(answer.split('\r\n')[0], method).toBe('HTTP/1.1 200 OK')
        const received = upstream.requests.slice(before)
        const seen = received.map(request => ({ method: request.method, path: request.path, body: request.body }))
        expect(seen, method).toEqual([{ method, path, body: SMUGGLED }])
        const headers = received[0]?.headers ?? {}
        expect(memberHeaderNames(headers), method).toEqual(signed ? [MEMBER_HEADER] : [])
        if (signed) expect(memberOf(headers[MEMBER_HEADER], w.clock), method).toBe(MEMBER)
      }
    })
  })

  it.each([
    ['Content-Length with Transfer-Encoding', 'Content-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n'],
    ['a coding before chunked', 'Transfer-Encoding: gzip, chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n'],
    ['a coding without chunked', 'Transfer-Encoding: gzip\r\n\r\nhello'],
  ])('answer 400 to %s before contacting anything upstream', async (_label, framing) => {
    const w = await world()
    for (const path of ['/api/rpc', '/assets/upload', '/ini-web2/upload']) {
      const answer = await exchange(w.port, `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: accessToken=${TOKEN}\r\n${framing}`)
      expect(answer.split('\r\n')[0], path).toBe('HTTP/1.1 400 Bad Request')
    }
    expect(w.dsh.requests.length + w.customer.requests.length + w.renewals()).toBe(0)
  })

  it('drop the upstream request, answer nothing, and log nothing when the client leaves before its body is complete', async () => {
    const started = Promise.withResolvers<true>()
    const closed = Promise.withResolvers<boolean>()
    const dsh = http.createServer((req) => {
      req.resume()
      req.on('close', () => { closed.resolve(req.complete) })
      started.resolve(true)
    })
    const dshPort = await listen(dsh)
    const settings = readSettings({ DSH_WEB_PORT: String(dshPort), REMOTE_HOST: '127.0.0.1', REMOTE_PORT: '9', LOGIN_GATE: 'off' })
    const logs: string[] = []
    const { server, gate } = createProxyServer(settings, { log: (line) => { logs.push(line) }, now: () => 0 })
    const port = await listen(server, gate)
    let received = ''
    const left = Promise.withResolvers<true>()
    const client = net.connect(port, '127.0.0.1', () => {
      client.write('POST /assets/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\npartial')
    })
    closers.push(async () => { client.destroy() })
    client.on('data', (chunk: Buffer) => { received += chunk.toString('latin1') })
    client.on('error', () => { client.destroy() })
    client.on('close', () => { left.resolve(true) })
    await started.promise
    client.end()
    expect(await closed.promise).toBe(false)
    await left.promise
    expect(received).toBe('')
    expect(logs).toEqual([])
  })
})

describe('a client that leaves during the login check', () => {
  const incomplete = `POST /api/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: accessToken=${TOKEN}\r\nContent-Length: 100\r\n\r\npartial`
  const complete = `GET /api/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: accessToken=${TOKEN}\r\n\r\n`

  it.each([
    ['with its body incomplete', 'end', incomplete],
    ['with its body incomplete', 'reset', incomplete],
    ['with its request complete', 'end', complete],
    ['with its request complete', 'reset', complete],
  ] as const)('causes no upstream request %s, leaving by %s, and no log line', async (_label, leave, text) => {
    const w = await heldWorld()
    await leaveDuringCheck(w, text, leave)
    w.release()
    // Admitted from the same check, so its upstream request is made after the departed client's would have been.
    expect((await send(w.port, '/api/rpc', LOGGED_IN)).status).toBe(200)
    expect(w.dshConnections()).toBe(1)
    expect(w.dsh.requests).toHaveLength(1)
    expect(w.logs).toEqual([])
  })

  it('causes no upstream upgrade when it resets the connection', async () => {
    const w = await heldWorld()
    await leaveDuringCheck(w, handshake('/api/remote.mux'), 'reset')
    w.release()
    expect(await upgrade(w.port, '/api/remote.mux', LOGGED_IN)).toBe(101)
    expect(w.dshConnections()).toBe(1)
    expect(w.dsh.upgrades).toHaveLength(1)
  })
})

describe('a client that leaves while its response streams', () => {
  it.each([
    ['an idle stream on a verified dsh path', 'chunk', '/api/events', 'dsh'],
    ['an idle stream on a remote-application path', 'chunk', '/ini-web2/events', 'remote'],
    ['a flowing stream on a verified dsh path', 'flood', '/api/events', 'dsh'],
    ['a flowing stream on a remote-application path', 'flood', '/ini-web2/events', 'remote'],
  ] as const)('closes the upstream connection of %s and logs nothing', async (_label, answer, path, target) => {
    const w = await streamingWorld(answer)
    const { client } = await readUntil(w.port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: accessToken=${TOKEN}\r\n\r\n`, FIRST_CHUNK)
    client.destroy()
    await w[target].closed(0)
    expect(w.logs).toEqual([])
  })

  it.each([
    ['a verified dsh path', '/api/poll', 'dsh'],
    ['a remote-application path', '/ini-web2/poll', 'remote'],
  ] as const)('closes the upstream connection on %s when the upstream has not answered yet, and logs nothing', async (_label, path, target) => {
    const w = await streamingWorld('silent')
    const client = net.connect(w.port, '127.0.0.1', () => {
      client.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: accessToken=${TOKEN}\r\n\r\n`)
    })
    closers.push(async () => { client.destroy() })
    client.on('error', () => { client.destroy() })
    await w[target].arrived(0)
    client.destroy()
    await w[target].closed(0)
    expect(w.logs).toEqual([])
  })

  it.each([
    ['verified dsh paths', '/api/first', '/api/second', 'dsh'],
    ['remote-application paths', '/ini-web2/first', '/ini-web2/second', 'remote'],
  ] as const)('closes the upstream connection of a response queued behind the streaming one on %s, and logs nothing', async (_label, first, second, target) => {
    const w = await streamingWorld('chunk')
    const request = (path: string) => `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: accessToken=${TOKEN}\r\n\r\n`
    const { client } = await readUntil(w.port, request(first) + request(second), FIRST_CHUNK)
    await w[target].arrived(1)
    client.destroy()
    await Promise.all([w[target].closed(0), w[target].closed(1)])
    expect(w.logs).toEqual([])
  })
})

describe('upgrades', () => {
  const paths = [
    ['a verified dsh path', '/api/remote.mux', 'dsh'],
    ['an exempt dsh path', '/plugins/events', 'dsh'],
    ['a remote-application path', '/toy-proxy/socket', 'remote'],
  ] as const

  it.each(paths)('send nothing after the handshake to an upstream that does not switch protocols on %s', async (_label, path, target) => {
    const w = await rawWorld('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')
    const answer = await exchange(w.port, handshake(path) + SMUGGLED)
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found')
    const received = await (target === 'dsh' ? w.dsh : w.remote).ended
    expect(received.indexOf('\r\n\r\n') + 4).toBe(received.length)
    expect(received.startsWith(`GET ${path} HTTP/1.1\r\n`)).toBe(true)
    expect(received).not.toContain('forged-by-the-client')
    const assertion = /^x-dsh-member: (.*)$/m.exec(received)?.[1]?.trim()
    expect(memberOf(assertion, { now: 1_800_000_000_000 })).toBe(path === '/api/remote.mux' ? MEMBER : undefined)
  })

  it('splice both directions once the upstream switches protocols', async () => {
    const w = await rawWorld('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nserver-hello')
    const client = net.connect(w.port, '127.0.0.1', () => { client.write(handshake('/api/remote.mux') + 'client-frame') })
    closers.push(async () => { client.destroy() })
    let fromUpstream = ''
    const hello = new Promise<string>((resolve) => {
      client.on('data', (chunk: Buffer) => {
        fromUpstream += chunk.toString('latin1')
        if (fromUpstream.endsWith('server-hello')) resolve(fromUpstream)
      })
    })
    expect((await hello).split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols')
    const received = await w.dsh.until('client-frame')
    expect(received.slice(received.indexOf('\r\n\r\n') + 4)).toBe('client-frame')
    client.write('second-frame')
    expect((await w.dsh.until('second-frame')).endsWith('client-framesecond-frame')).toBe(true)
  })

  it.each([
    ['a dsh path without a credential', '/api/remote.mux', ''],
    ['a verified dsh path', '/api/remote.mux', `Cookie: accessToken=${TOKEN}\r\n`],
    ['a remote-application path', '/ini-web2/socket', ''],
  ] as const)('close the connection with nothing written when an earlier response on it is in progress, on %s', async (_label, path, cookie) => {
    const w = await streamingWorld('chunk')
    const { client, received, closed } = await readUntil(w.port, 'GET /ini-web2/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n', FIRST_CHUNK)
    client.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${cookie}\r\n`)
    await Promise.all([closed, w.remote.closed(0)])
    const answer = received()
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    expect(answer.slice(answer.indexOf('\r\n\r\n'))).not.toMatch(/HTTP\/1\.[01] \d{3}/)
    expect([...w.dsh.upgrades, ...w.remote.upgrades]).toEqual([])
    expect(w.logs).toEqual(['proxy: refused upgrade: a response on its connection is in progress'])
  })

  it('switch protocols on a connection whose earlier response has completed', async () => {
    const w = await world()
    const connection = await readUntil(w.port, 'GET /assets/a HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n', '\r\n\r\nok')
    connection.client.write(handshake('/plugins/events'))
    await connection.until('\r\n\r\nokHTTP/1.1 101 Switching Protocols\r\n')
    expect(w.dsh.upgrades).toHaveLength(1)
  })

  it('answer 502 when the upstream closes before answering the handshake', async () => {
    const w = await rawWorld(undefined)
    expect((await exchange(w.port, handshake('/plugins/events'))).split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway')
  })

  it.each(paths)('answer 502, as a request does, when the upstream cannot be reached on %s', async (_label, path) => {
    const renewal = await stub((req, res) => {
      res.end(JSON.stringify({ renewal: '3600000', token: req.headers.authorization }))
      return true
    })
    const settings = readSettings({
      DSH_WEB_PORT: String(await closedPort()),
      REMOTE_HOST: '127.0.0.1',
      REMOTE_PORT: String(await closedPort()),
      AUTH_ORIGIN: `http://127.0.0.1:${String(renewal.port)}`,
    })
    const { server, gate } = createProxyServer(settings, { log: () => {}, now: () => 1_800_000_000_000 })
    const port = await listen(server, gate)
    expect((await exchange(port, handshake(path))).split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway')
    const request = handshake(path).replace(/Connection: Upgrade\r\nUpgrade: websocket\r\n/, 'Connection: close\r\n')
    expect((await exchange(port, request)).split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway')
  })

  it.each(paths)('answer 400 to a handshake that declares a body on %s, before contacting anything upstream', async (_label, path) => {
    const w = await world()
    for (const framing of [framedBody('content-length', SMUGGLED), framedBody('chunked', SMUGGLED)]) {
      const answer = await exchange(w.port, handshake(path).slice(0, -2) + framing)
      expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request')
    }
    expect(w.dsh.upgrades.length + w.customer.upgrades.length + w.dsh.requests.length + w.customer.requests.length + w.renewals()).toBe(0)
  })
})

describe('malformed requests', () => {
  const modes = [['proxy', {}], ['verify', { PROXY_MODE: 'verify' }]] as const
  /** A request Node's parser refuses: a space before a header name's colon. */
  const spacedName = 'GET /assets/a HTTP/1.1\r\nHost: 127.0.0.1\r\nx-dsh-member : spaced\r\n\r\n'

  it('close the connection without a status when an earlier response on it has started, in proxy mode', async () => {
    const w = await streamingWorld()
    const { client, received, closed } = await readUntil(w.port, `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: accessToken=${TOKEN}\r\n\r\n`, FIRST_CHUNK)
    client.write(spacedName)
    await closed
    const answer = received()
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    expect(answer.slice(answer.indexOf('\r\n\r\n'))).not.toMatch(/HTTP\/1\.[01] \d{3}/)
  })

  it.each([
    ['proxy', {}, 'GET /assets/a HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n', '\r\n\r\nok'],
    ['verify', { PROXY_MODE: 'verify' }, `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`, '\r\n\r\n'],
  ] as const)('are answered 400 after an earlier response on the same connection has completed in %s mode', async (_mode, env, first, end) => {
    const w = await world(env)
    const { client, received, closed } = await readUntil(w.port, first, end)
    client.write(spacedName)
    await closed
    const answer = received()
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    expect(answer.slice(answer.indexOf(end) + end.length).split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request')
  })

  it.each(modes)('are answered 431 when the header section is over Node\'s limit in %s mode', async (_mode, env) => {
    const w = await world(env)
    const answer = await exchange(w.port, `GET /assets/a HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Padding: ${'a'.repeat(20_000)}\r\n\r\n`)
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 431 Request Header Fields Too Large')
    expect(w.dsh.requests.length + w.renewals()).toBe(0)
  })

  it.each([
    ['proxy', {}, 'POST /assets/a HTTP/1.1\r\nHost: 127.0.0.1\r\n'],
    ['verify', { PROXY_MODE: 'verify' }, `POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n`],
  ] as const)('are answered 413 when a chunk\'s extensions are over Node\'s limit in %s mode', async (_mode, env, head) => {
    const w = await world(env)
    const answer = await exchange(w.port, `${head}Transfer-Encoding: chunked\r\n\r\n1;${'a'.repeat(20_000)}\r\nz\r\n0\r\n\r\n`)
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 413 Payload Too Large')
  })

  it.each(modes)('are answered 408 when the header section does not arrive in time in %s mode', async (_mode, env) => {
    const settings = readSettings({ DSH_WEB_PORT: '9', REMOTE_HOST: '127.0.0.1', REMOTE_PORT: '9', AUTH_ORIGIN: 'http://127.0.0.1:9', ...env })
    const runtime = { log: () => {}, now: () => 0 }
    const { server, gate } = settings.mode === 'verify' ? createVerifierServer(settings, runtime) : createProxyServer(settings, runtime)
    // Node reads connectionsCheckingInterval, how often it checks these deadlines, when the server starts listening.
    Object.assign(server, { headersTimeout: 200, requestTimeout: 200, connectionsCheckingInterval: 50 })
    const port = await listen(server, gate)
    expect((await exchange(port, 'GET /assets/a HTTP/1.1\r\nHost: 127.0.0.1\r\n')).split('\r\n')[0]).toBe('HTTP/1.1 408 Request Timeout')
  })

  it.each(modes)('are answered nothing and logged nothing when the client leaves mid-request in %s mode', async (_mode, env) => {
    const w = await world(env)
    expect(await sendAndEnd(w.port, 'GET /assets/a HTTP/1.1\r\nHost: 127.0.0.1\r\n')).toBe('')
    expect(w.logs).toEqual([])
  })

  it.each(modes)('are answered 400 in %s mode', async (_mode, env) => {
    const w = await world(env)
    for (const text of [
      'GET /assets/a HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Other: a\r\n x-dsh-member: folded\r\n\r\n',
      spacedName,
      'POST /assets/a HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello',
    ]) {
      expect((await exchange(w.port, text)).split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request')
    }
    expect(w.dsh.requests.length + w.renewals()).toBe(0)
  })
})

describe('node proxy.mjs', () => {
  const script = fileURLToPath(new URL('../deploy/proxy.mjs', import.meta.url))
  const required = { DSH_WEB_PORT: '3739', REMOTE_HOST: '127.0.0.1', REMOTE_PORT: '9532' }

  /**
   * Run the gate as a deployment does, with only the given variables set.
   * @param env - the gate's environment.
   * @returns how the process ended and what it printed on stderr.
   */
  function run(env: Record<string, string>): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      closers.push(async () => { child.kill() })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('error', reject)
      child.on('close', (code, signal) => { resolve({ code, signal, stderr }) })
    })
  }

  it('exits 1 naming PROXY_PORT when the port is in use', async () => {
    const port = await listen(net.createServer())
    const ended = await run({ ...required, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(port) })
    expect(ended.signal).toBeNull()
    expect(ended.code).toBe(1)
    expect(ended.stderr).toContain(`proxy: cannot listen on PROXY_PORT=${String(port)}: EADDRINUSE`)
  })

  it('exits 1 naming PROXY_HOST when the address is not local', async () => {
    // 192.0.2.0/24 is reserved for documentation (RFC 5737) and assigned to no interface.
    const ended = await run({ ...required, PROXY_HOST: '192.0.2.1' })
    expect(ended.signal).toBeNull()
    expect(ended.code).toBe(1)
    expect(ended.stderr).toContain('proxy: cannot listen on PROXY_HOST=192.0.2.1: EADDRNOTAVAIL')
  })
})

describe('gate', () => {
  it('shares one check among concurrent requests and asks again once the admission expires', async () => {
    let renewals = 0
    const customer = await stub((req, res) => {
      renewals += 1
      res.end(JSON.stringify({ renewal: '3600000', token: req.headers.authorization }))
      return true
    })
    const clock = { now: 1_800_000_000_000 }
    const gate = createGate(readSettings({ PROXY_MODE: 'verify', AUTH_ORIGIN: `http://127.0.0.1:${String(customer.port)}`, AUTH_CACHE_SECONDS: '30' }), { log: () => {}, now: () => clock.now })
    closers.push(async () => { gate.close() })
    const credential = `Bearer ${TOKEN}`
    const admitted = { outcome: 'admitted', member: MEMBER }
    expect(await Promise.all([gate.authorize(credential), gate.authorize(credential)])).toEqual([admitted, admitted])
    expect(renewals).toBe(1)
    clock.now += 29_000
    expect(await gate.authorize(credential)).toEqual(admitted)
    expect(renewals).toBe(1)
    clock.now += 2_000
    expect(await gate.authorize(credential)).toEqual(admitted)
    expect(renewals).toBe(2)
  })
})

describe('verify mode', () => {
  it('answers 200 with a fresh assertion for a verified login, whatever member header the subrequest carries', async () => {
    const w = await world({ PROXY_MODE: 'verify' })
    const answer = await send(w.port, '/', { 'authorization': `Bearer ${TOKEN}`, 'x-dsh-member': 'forged-by-the-client' })
    expect(answer.status).toBe(200)
    expect(memberOf(answer.headers[MEMBER_HEADER], w.clock)).toBe(MEMBER)
    expect(w.dsh.requests).toHaveLength(0)
  })

  it('answers 401 with no assertion to an empty or refused credential and 503 to an unavailable service', async () => {
    const w = await world({ PROXY_MODE: 'verify' }, () => ({ status: 403, body: '' }))
    const empty = await send(w.port, '/', { authorization: 'Bearer ' })
    expect(empty.status).toBe(401)
    expect(empty.headers[MEMBER_HEADER]).toBeUndefined()
    expect(w.renewals()).toBe(0)
    const refused = await send(w.port, '/', { authorization: `Bearer ${TOKEN}` })
    expect(refused.status).toBe(401)
    expect(refused.headers[MEMBER_HEADER]).toBeUndefined()

    const down = await world({ PROXY_MODE: 'verify' }, () => ({ status: 504, body: '' }))
    expect((await send(down.port, '/', { authorization: `Bearer ${TOKEN}` })).status).toBe(503)
  })

  it.each([
    ['jti', memberToken({ jti: 'jti-2' })],
    ['login_uid', memberToken({ uid: OTHER_MEMBER })],
  ])('answers 401 with no assertion when the renewal reply carries another %s', async (_claim, replied) => {
    const w = await world({ PROXY_MODE: 'verify' }, () => ({ status: 200, body: JSON.stringify({ renewal: '3600000', token: replied }) }))
    const answer = await send(w.port, '/', { authorization: `Bearer ${TOKEN}` })
    expect(answer.status).toBe(401)
    expect(answer.headers[MEMBER_HEADER]).toBeUndefined()
  })

  it('answers 200 with no header when no signing key is configured', async () => {
    const w = await world({ PROXY_MODE: 'verify', MEMBER_ASSERTION_KEY_FILE: undefined, MEMBER_ASSERTION_DEPLOYMENT_ID: undefined })
    const answer = await send(w.port, '/', { authorization: `Bearer ${TOKEN}` })
    expect(answer.status).toBe(200)
    expect(answer.headers[MEMBER_HEADER]).toBeUndefined()
  })
})

describe('logs', () => {
  it('never carry the member id, the token, or an assertion', async () => {
    const printed: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')) })
      closers.push(async () => { spy.mockRestore() })
    }
    let reply: Renewal = ECHO_RENEWAL
    const w = await world({}, authorization => reply(authorization))
    const verifier = await world({ PROXY_MODE: 'verify' }, authorization => reply(authorization))
    const seen: string[] = []
    const record = (value: string | string[] | undefined) => {
      if (typeof value === 'string') seen.push(value)
    }

    await send(w.port, '/api/rpc', LOGGED_IN)
    record(lastMemberHeader(w.dsh.requests))
    await upgrade(w.port, '/api/remote.mux', LOGGED_IN)
    record(lastMemberHeader(w.dsh.upgrades))
    record((await send(verifier.port, '/', { authorization: `Bearer ${TOKEN}` })).headers[MEMBER_HEADER])
    await send(w.port, '/api/rpc', { cookie: `accessToken=${jwt('{"sub":"alice"}')}` })

    const mismatched = memberToken({ uid: OTHER_MEMBER, jti: 'jti-2' })
    reply = () => ({ status: 200, body: JSON.stringify({ token: TOKEN }) })
    await send(w.port, '/api/rpc', { cookie: `accessToken=${mismatched}` })
    await send(verifier.port, '/', { authorization: `Bearer ${mismatched}` })
    reply = () => ({ status: 500, body: '' })
    const fresh = memberToken({ jti: 'jti-3' })
    await send(w.port, '/api/rpc', { cookie: `accessToken=${fresh}` })

    expect(seen).toHaveLength(3)
    const logs = [...w.logs, ...verifier.logs, ...printed].join('\n')
    expect(logs).toContain('reply-mismatch')
    expect(logs).toContain('-> 500')
    for (const secret of [MEMBER, OTHER_MEMBER, TOKEN, mismatched, fresh, ...seen]) expect(logs).not.toContain(secret)
  })
})
