// The prefix proxy that stands in for the deployment's nginx, checked against a
// real upstream: what the upstream sees is the whole assertion, because a proxy
// that strips half a prefix produces the harness's path-traversal 403 rather
// than a routing failure anyone would recognize.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { startPrefixProxy, stripPrefix, type PrefixProxy } from './prefix-proxy.ts'

const PREFIX = '/console/'

/** The upstream `dsh web` stands in for, recording what actually reached it. */
interface Upstream {
  port: number
  /** Request paths the upstream saw, in arrival order. */
  paths: string[]
  /** Upgrade requests the upstream saw, path and headers. */
  upgrades: { path: string; headers: NodeJS.Dict<string | string[]> }[]
  /** Releases the second SSE chunk of the `/sse` route. */
  releaseStream(): void
  close(): Promise<void>
}

/**
 * Start the upstream.
 * @returns the running upstream, already listening on 127.0.0.1.
 */
async function startUpstream(): Promise<Upstream> {
  const paths: string[] = []
  const upgrades: { path: string; headers: NodeJS.Dict<string | string[]> }[] = []
  let release = (): void => {}
  const released = new Promise<void>((resolve) => { release = resolve })

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/'
    paths.push(path)
    if (path === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write('data: one\n\n')
      void released.then(() => {
        res.write('data: two\n\n')
        res.end()
      })
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(path)
  })

  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    upgrades.push({ path: req.url ?? '/', headers: req.headers })
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `X-Upstream-Path: ${req.url ?? '/'}`,
      `X-Upstream-Key: ${String(req.headers['sec-websocket-key'])}`,
      '',
      '',
    ].join('\r\n'))
    socket.end()
  })

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    paths,
    upgrades,
    releaseStream: () => { release() },
    close: () => new Promise<void>((resolve) => {
      release()
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}

/**
 * Send a raw `Upgrade` request through the proxy and read the reply verbatim.
 * @param proxy - the proxy under test.
 * @param path - request path, prefix included.
 * @returns everything the proxy wrote back before closing.
 */
async function rawUpgrade(proxy: PrefixProxy, path: string): Promise<string> {
  const { hostname, port } = new URL(proxy.origin)
  const socket = connect({ host: hostname, port: Number(port) })
  const chunks: Buffer[] = []
  const reply = new Promise<string>((resolve, reject) => {
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    socket.on('close', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    socket.on('error', reject)
  })
  await new Promise<void>((resolve) => { socket.once('connect', resolve) })
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n'))
  return await reply
}

let upstream: Upstream
let proxy: PrefixProxy

beforeEach(async () => {
  upstream = await startUpstream()
  proxy = await startPrefixProxy({ targetPort: upstream.port, prefix: PREFIX })
})

afterEach(async () => {
  await proxy.close()
  await upstream.close()
})

it('maps every path under the prefix onto the upstream root', () => {
  expect(stripPrefix('/console/', PREFIX)).toBe('/')
  expect(stripPrefix('/console/api/session.export?sessionId=1', PREFIX)).toBe('/api/session.export?sessionId=1')
  // The slashless form is published by nothing: that nginx cannot redirect it,
  // so it is as much "not under the prefix" as a neighbouring path is.
  expect(stripPrefix('/console', PREFIX)).toBeUndefined()
  // A neighbouring path that merely shares the leading characters is not under
  // the prefix.
  expect(stripPrefix('/consoles/api', PREFIX)).toBeUndefined()
  expect(stripPrefix('/api/x', PREFIX)).toBeUndefined()
  // A root deployment is the identity case, not a special one.
  expect(stripPrefix('/api/x', '/')).toBe('/api/x')
})

it('rejects a prefix that is not bounded by slashes', async () => {
  await expect(startPrefixProxy({ targetPort: upstream.port, prefix: '/console' }))
    .rejects.toThrow(/must start and end/)
})

it('strips the prefix whole before the upstream sees the request', async () => {
  const response = await fetch(`${proxy.baseUrl}plugins/x/client.js?rev=fx`)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('/plugins/x/client.js?rev=fx')
  expect(upstream.paths).toEqual(['/plugins/x/client.js?rev=fx'])
})

it('answers a path outside the prefix itself instead of forwarding it', async () => {
  const response = await fetch(`${proxy.origin}/api/session.list`)
  expect(response.status).toBe(404)
  await response.arrayBuffer()
  expect(upstream.paths).toEqual([])
})

it('passes an upgrade handshake through in both directions', async () => {
  const reply = await rawUpgrade(proxy, `${PREFIX}api/events.mux`)
  expect(reply.startsWith('HTTP/1.1 101 Switching Protocols')).toBe(true)
  expect(reply).toContain('Upgrade: websocket')
  expect(reply).toContain('X-Upstream-Path: /api/events.mux')
  // The client's own handshake headers reached the upstream unaltered; a
  // dropped `Sec-WebSocket-Key` is what a rewritten header set looks like.
  expect(reply).toContain('X-Upstream-Key: dGhlIHNhbXBsZSBub25jZQ==')
  expect(upstream.upgrades.map(entry => entry.path)).toEqual(['/api/events.mux'])
  expect(upstream.upgrades[0]?.headers.upgrade).toBe('websocket')
})

it('destroys an upgrade whose path is outside the prefix', async () => {
  expect(await rawUpgrade(proxy, '/api/events.mux')).toBe('')
  expect(upstream.upgrades).toEqual([])
})

it('forwards a streaming response chunk by chunk instead of buffering it', async () => {
  const response = await fetch(`${proxy.baseUrl}sse`)
  expect(response.body).not.toBeNull()
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  // The upstream still holds the response open, so this chunk can only arrive
  // through a proxy that forwards as it reads.
  const first = await reader.read()
  expect(first.value).toBe('data: one\n\n')
  upstream.releaseStream()
  let rest = ''
  for (let next = await reader.read(); !next.done; next = await reader.read()) rest += next.value ?? ''
  expect(rest).toBe('data: two\n\n')
})
