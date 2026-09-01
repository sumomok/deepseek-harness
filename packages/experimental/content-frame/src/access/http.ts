/**
 * The plumbing both read routes share: method gating, the same-site JSON fence,
 * a bounded body reader, and the answers a route writes.
 *
 * A plugin route is outside the shell's own `/api` fence — that one guards
 * `/api` alone — so each route states its own. `cross-site` is the marker that
 * fence refuses too, and requiring the content type withdraws these routes from
 * the CORS-simple set a cross-origin page can post to without a preflight.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/http
 */

import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Answer one JSON document with no caching; these routes serve request-local truth.
 * @param res - the response.
 * @param status - the HTTP status.
 * @param body - the document to serialize.
 */
export function answerJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Answer a request whose body was not read to its end, closing the connection
 * with the answer.
 *
 * `connection: close` is what bounds the refusal. Node accounts for the request
 * body when the exchange finishes: a body nothing consumed it drains off the
 * wire itself, and a body a reader stopped consuming would otherwise be left
 * half-read on a connection held open for the next request. The header makes
 * node destroy the socket once the answer has flushed, so nothing past what the
 * socket already held is read — without it, refusing a large post costs reading
 * all of it.
 * @param res - the response.
 * @param status - the HTTP status.
 * @param body - the document to serialize.
 */
export function refuseUnread(res: ServerResponse, status: number, body: unknown): void {
  // Set rather than passed through: `answerJson` owns the JSON headers, and
  // `writeHead` merges whatever is already on the response.
  res.setHeader('connection', 'close')
  answerJson(res, status, body)
}

/**
 * Answer a request whose method the route does not serve.
 * @param res - the response.
 * @param allow - the complete method set this exact path serves.
 */
export function rejectMethod(res: ServerResponse, allow: string): void {
  // `allow` because these routes own their exact paths: nothing else can answer
  // the method the caller asked for, so the response states the complete set.
  // `connection: close` for the reason {@link refuseUnread} states: whatever
  // body the refused request carried was never read.
  res.writeHead(405, { allow, connection: 'close' })
  res.end()
}

/**
 * Refuse a post a browser labelled cross-site, or one that is not sent as JSON.
 * Applied before the body is read, so both refusals close the connection.
 *
 * The content-type test is a prefix match on `application/json` after leading
 * whitespace, case-insensitively. What it admits is neither a superset nor a
 * subset of the JSON media types: `application/jsonfoobar` passes and is no
 * kind of JSON, while `application/ld+json` and `application/merge-patch+json`
 * are refused and are. The conclusion holds regardless, because the CORS-simple
 * content types are exactly `text/plain`, `application/x-www-form-urlencoded`
 * and `multipart/form-data`, and none of the three begins with
 * `application/json` — so every request this admits costs a cross-origin poster
 * a preflight, which is what withdraws these routes from what a page can post
 * to unasked.
 * @param req - the incoming request.
 * @param res - the response, answered here when the request is refused.
 * @param route - the route naming itself in the refusal.
 * @returns true when the request was refused and the handler must stop.
 */
export function rejectUntrustedPost(req: IncomingMessage, res: ServerResponse, route: string): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    refuseUnread(res, 403, { error: `content-frame: ${route} serves same-site requests only` })
    return true
  }
  const contentType = req.headers['content-type']
  if (contentType === undefined || !contentType.toLowerCase().trimStart().startsWith('application/json')) {
    refuseUnread(res, 415, { error: `content-frame: ${route} accepts application/json only` })
    return true
  }
  return false
}

/** What one bounded read of a request body ended as. */
export type BodyRead =
  | {
    /** Discriminant: the body arrived within the bound and decoded. */
    kind: 'json'
    /** The decoded document. */
    value: unknown
  }
  | {
    /** Discriminant: the body is longer than the bound and was not read past it. */
    kind: 'oversize'
  }
  | {
    /** Discriminant: the body arrived in full and is not JSON. */
    kind: 'not-json'
  }

/**
 * Read one request body, stopping at the bound rather than taking what is past it.
 *
 * The bound is a running total over the chunks as they arrive, and a declared
 * `content-length` is not consulted. Refusing on the header alone would leave
 * the body unconsumed, and node drains a body nothing consumed off the wire in
 * full once the response finishes — so refusing a request for its size would
 * cost its size. Reading up to the bound and stopping there is what keeps that
 * drain from running: at the first chunk that crosses, the read drops its data
 * listener and pauses the request. It does not destroy the request, because the
 * route still has a refusal to write; closing the connection belongs to that
 * answer, which is {@link refuseUnread}'s to make.
 * @param req - the incoming request.
 * @param limit - largest accepted body in bytes.
 * @returns what the read ended as.
 * @throws {Error} when the request errors before its body ends, which is how
 * node reports a caller that disconnected mid-body.
 */
export function readJsonBody(req: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise<BodyRead>((resolve, reject) => {
    req.setEncoding('utf8')
    let text = ''
    let size = 0
    const onData = (chunk: string): void => {
      size += Buffer.byteLength(chunk)
      if (size <= limit) {
        text += chunk
        return
      }
      req.off('data', onData)
      req.pause()
      resolve({ kind: 'oversize' })
    }
    req.on('data', onData)
    req.on('end', () => {
      try {
        resolve({ kind: 'json', value: JSON.parse(text) as unknown })
      } catch (_bodyIsNotJson) {
        // The only thing a malformed body can mean here is a caller that is not
        // this package's browser half; the 400 the caller gets says so.
        resolve({ kind: 'not-json' })
      }
    })
    // Left attached past every settlement: a request that errors with no
    // listener throws in the process, and settling twice is a no-op.
    req.on('error', reject)
  })
}

/** The two sentences a route answers a body it cannot use with. */
export interface BodyRefusals {
  /** The 413, naming the route and the byte bound it holds a body to. */
  oversize: string
  /** The 400, naming the document this route takes. */
  shape: string
}

/**
 * Answer the endings a bounded read settles on its own, leaving the route a
 * decoded document to check the shape of.
 *
 * The 413 is written while the body is still arriving, so it closes the
 * connection; the 400 for a body that arrived in full and is not JSON is the
 * same answer a well-formed body of the wrong shape gets, and leaves the
 * connection alive.
 * @param res - the response, answered here for either refusal.
 * @param read - what {@link readJsonBody} ended with.
 * @param refusals - this route's own two sentences.
 * @returns the decoded document, or `undefined` when the read was answered here.
 */
export function takeJsonBody(
  res: ServerResponse,
  read: BodyRead,
  refusals: BodyRefusals,
): { value: unknown } | undefined {
  if (read.kind === 'oversize') {
    refuseUnread(res, 413, { error: refusals.oversize })
    return undefined
  }
  if (read.kind === 'not-json') {
    answerJson(res, 400, { error: refusals.shape })
    return undefined
  }
  return { value: read.value }
}
