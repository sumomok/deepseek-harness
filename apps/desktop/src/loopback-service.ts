/**
 * The parts every loopback service in this shell shares: where it listens, the
 * bearer token it mints, how that token is compared, how a body is read under a
 * cap, and how one answer is written.
 *
 * The shell lends the embedded server capabilities it cannot have on its own —
 * a Chromium to render with, a package manager to update plugins with — and it
 * lends each of them over its own HTTP listener rather than over one shared
 * surface. Each service mints its own token, so admission to one is never
 * admission to another. What they have in common is only this module: the
 * loopback address, a 32-byte token compared in constant time, and the two
 * answer writers. There is no CORS handling anywhere, because no browser origin
 * is meant to reach any of them.
 *
 * A service's own routing, validation, and behavior stay in its own module;
 * nothing here knows what any route does.
 * @module @deepseek-ai/dsh-desktop/loopback-service
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** The only address these services bind, so nothing off the machine can reach them. */
export const LOOPBACK_HOST = '127.0.0.1'

/** Bearer token length. 32 bytes of `randomBytes` is not guessable by another local process. */
const TOKEN_BYTES = 32

/**
 * Mint one service's bearer token.
 *
 * Callers generate rather than accept a token, so there is no way to run a
 * service with a value that came from anywhere but `randomBytes`.
 * @returns the token, hex encoded.
 */
export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/**
 * Whether an `authorization` header carries exactly this service's token.
 *
 * The comparison is length-checked first and then constant-time, so the reply
 * timing says nothing about how much of a guessed token was right.
 * @param header - the request's `authorization` header, if it sent one.
 * @param token - the token this service accepts.
 * @returns true when the header is `Bearer <token>` for that exact token.
 */
export function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false
  const offered = /^Bearer[ ]+(\S+)$/i.exec(header.trim())?.[1]
  if (offered === undefined) return false
  const left = Buffer.from(offered, 'utf8')
  const right = Buffer.from(token, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/**
 * Read a request body, keeping at most `maxBodyBytes` of it.
 *
 * An oversized upload is read to its end and discarded rather than cut off:
 * memory stays bounded either way, and destroying the request mid-upload would
 * take the socket down with it, so the caller would get a dropped connection
 * where it should get the sentence saying what was wrong.
 * @param request - the incoming request.
 * @param maxBodyBytes - the largest body to accept.
 * @returns the body text, or undefined when the request sent more than the cap.
 */
export async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = chunk as Buffer
    size += bytes.byteLength
    if (size <= maxBodyBytes) chunks.push(bytes)
  }
  if (size > maxBodyBytes) return undefined
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Answer with a status and one line of plain text.
 *
 * Every failure these services report is one sentence, because their callers
 * are tools that put it in a message, not pages that format it.
 * @param response - the response to write.
 * @param status - the HTTP status.
 * @param message - the single line explaining it.
 * @param extra - headers this answer carries beyond the three below.
 */
export function sendText(response: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  if (response.headersSent) {
    response.end()
    return
  }
  const body = Buffer.from(`${message}\n`, 'utf8')
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
    ...extra,
  })
  response.end(body)
}

/**
 * Answer with a status and a JSON body, which is what every route that reports
 * fields rather than bytes returns.
 * @param response - the response to write.
 * @param status - the HTTP status.
 * @param value - the body, serialized as JSON.
 */
export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.byteLength })
  response.end(body)
}

/**
 * Listen on an ephemeral loopback port and report the origin to hand out.
 * @param server - the server to start.
 * @param label - the service's name, used in the one failure this throws.
 * @returns the origin a caller POSTs to.
 * @throws when the listener cannot be opened, or reports no TCP address.
 */
export async function listenLoopback(server: Server, label: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error(`${label}: the loopback listener reported no TCP address`)
  }
  return `http://${LOOPBACK_HOST}:${String(address.port)}`
}
