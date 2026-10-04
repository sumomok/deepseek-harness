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

import http from 'node:http'
import type { IncomingHttpHeaders, OutgoingHttpHeaders, Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { generateKeyPairSync, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASSERTION_LIFETIME_SECONDS,
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
  path: string
  headers: IncomingHttpHeaders
}

/** A stand-in server with what it received. */
interface Stub {
  server: Server
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
 * upgraded sockets included.
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
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    })
  })
  return (server.address() as AddressInfo).port
}

/**
 * A stand-in server that records every request and upgrade and answers 200 or
 * 101; `answer` may claim a path first.
 * @param answer - answers a path itself and returns true, or returns false.
 * @returns the stub.
 */
async function stub(answer: (req: http.IncomingMessage, res: http.ServerResponse) => boolean = () => false): Promise<Stub> {
  const requests: Received[] = []
  const upgrades: Received[] = []
  const server = http.createServer((req, res) => {
    req.resume()
    if (answer(req, res)) return
    requests.push({ path: req.url ?? '', headers: req.headers })
    res.end('ok')
  })
  server.on('upgrade', (req, socket) => {
    upgrades.push({ path: req.url ?? '', headers: req.headers })
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
  it('removes the member header in any casing and attaches only the given assertion', () => {
    const headers = { 'X-Dsh-Member': 'forged', 'x-dsh-member': 'forged', 'connection': 'keep-alive', 'accept': 'text/html' }
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
