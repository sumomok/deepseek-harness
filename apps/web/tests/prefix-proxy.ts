/**
 * A prefix-stripping reverse proxy for the browser lane, standing in for the
 * deployment's nginx: it publishes the shell under `/<prefix>/` and forwards
 * every request to a `dsh web` listening on the origin root, exactly as the
 * production `location /console/ { proxy_pass http://…/; }` pair does.
 *
 * Three behaviors matter to the scenarios that use it. The prefix is stripped
 * whole, so the harness process keeps seeing the root-absolute routes it
 * registers. A path that is not under the prefix is answered 404 here rather
 * than forwarded, which is what makes "the prefix must be stripped, never
 * passed through" a mechanically observable deployment rule instead of a note.
 * And `Upgrade` requests and streaming responses pass through untouched and
 * unbuffered, because the two WebSocket downlinks and the SSE fallback are the
 * traffic most likely to break on a misconfigured proxy.
 *
 * The `Host` header is forwarded verbatim, matching `proxy_set_header Host
 * $host`: the harness derives its trusted-origin verdict from it.
 * @module apps/web/tests/prefix-proxy
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

/** A running prefix proxy; the caller owns it and closes it. */
export interface PrefixProxy {
  /** Scheme and authority the proxy listens on, no trailing slash. */
  readonly origin: string
  /** The shell's public address through the proxy: `origin` plus the prefix, trailing slash included. */
  readonly baseUrl: string
  /** Stop listening and drop every open connection. */
  close(): Promise<void>
}

/** What to publish, and where to send it. */
export interface PrefixProxyOptions {
  /** Port of the upstream `dsh web` on 127.0.0.1. */
  targetPort: number
  /** Deployment prefix to publish under, leading and trailing slash included. */
  prefix: string
}

/**
 * Map a request path the browser asked for onto the path the upstream expects.
 * Only the slash-terminated prefix is published, as in the deployment: that
 * nginx carries no rewrite module, so it can neither redirect the slashless
 * `/console` nor usefully serve it — a document there sits outside the
 * `Path=/console/` the page writes its cookies with — and every link published
 * outward carries the trailing slash.
 * @param requestPath - `req.url`, path and query as the client sent them.
 * @param prefix - deployment prefix, leading and trailing slash included.
 * @returns the upstream path, or undefined when the request is not under the prefix.
 */
export function stripPrefix(requestPath: string, prefix: string): string | undefined {
  if (!requestPath.startsWith(prefix)) return undefined
  return `/${requestPath.slice(prefix.length)}`
}

/**
 * Rebuild the upstream's `101 Switching Protocols` reply so it can be written
 * back to the client socket byte for byte; `http.request` parses the handshake
 * away, and only the raw header pairs survive that parse in order.
 * @param upstream - the upstream response carrying the handshake.
 * @returns the serialized status line and headers, terminated by a blank line.
 */
function handshake(upstream: IncomingMessage): string {
  const lines = [`HTTP/1.1 ${String(upstream.statusCode ?? 101)} ${upstream.statusMessage ?? 'Switching Protocols'}`]
  for (let index = 0; index + 1 < upstream.rawHeaders.length; index += 2) {
    lines.push(`${String(upstream.rawHeaders[index])}: ${String(upstream.rawHeaders[index + 1])}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * Start the proxy.
 * @param options - upstream port and the prefix to publish under.
 * @returns the running proxy, already listening.
 * @throws {Error} when the prefix is not bounded by slashes on both sides.
 */
export async function startPrefixProxy(options: PrefixProxyOptions): Promise<PrefixProxy> {
  const { targetPort, prefix } = options
  if (!prefix.startsWith('/') || !prefix.endsWith('/')) {
    throw new Error(`prefix proxy: prefix ${JSON.stringify(prefix)} must start and end with '/'`)
  }

  const forward = (path: string, req: IncomingMessage): ReturnType<typeof httpRequest> => httpRequest({
    host: '127.0.0.1',
    port: targetPort,
    method: req.method ?? 'GET',
    path,
    headers: req.headers,
  })

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = stripPrefix(req.url ?? '/', prefix)
    if (path === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`prefix proxy: ${req.url ?? ''} is not under ${prefix}\n`)
      return
    }
    const upstream = forward(path, req)
    upstream.on('response', (proxied: IncomingMessage) => {
      res.writeHead(proxied.statusCode ?? 502, proxied.headers)
      // Streaming responses (SSE) must reach the client as they arrive: send the
      // headers before the first chunk and pipe, never collect.
      res.flushHeaders()
      proxied.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('prefix proxy: upstream failed\n')
    })
    req.pipe(upstream)
  })

  server.on('upgrade', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const path = stripPrefix(req.url ?? '/', prefix)
    if (path === undefined) {
      client.destroy()
      return
    }
    const upstream = forward(path, req)
    upstream.on('upgrade', (proxied: IncomingMessage, peer: Socket, peerHead: Buffer) => {
      client.write(handshake(proxied))
      if (peerHead.length > 0) client.write(peerHead)
      if (head.length > 0) peer.write(head)
      peer.pipe(client)
      client.pipe(peer)
      peer.on('error', () => { client.destroy() })
      client.on('error', () => { peer.destroy() })
    })
    upstream.on('error', () => { client.destroy() })
    upstream.end()
  })

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${String(port)}`
  return {
    origin,
    baseUrl: `${origin}${prefix}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}
