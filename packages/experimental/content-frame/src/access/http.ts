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
 * Answer one document and close the connection with it, for an exchange that
 * will not read to the end of the body it was sent.
 * @param res - the response.
 * @param status - the HTTP status.
 * @param body - the document to serialize.
 */
function answerClosing(res: ServerResponse, status: number, body: unknown): void {
  // Set rather than passed through: `answerJson` owns the JSON headers, and
  // `writeHead` merges whatever is already on the response.
  res.setHeader('connection', 'close')
  answerJson(res, status, body)
}

/**
 * Count one refused request's body off the wire and keep none of it, stopping
 * at the bound.
 *
 * Consuming is the point. Node drains a body nothing consumed off the wire
 * itself once the exchange finishes, so a route that answers without reading
 * pays for the whole body anyway, while a body something has already consumed
 * it leaves alone. The bound is what keeps this from becoming the drain it
 * replaces: at the first chunk that crosses it, the count drops its listener
 * and pauses the request, and the refusal that follows closes the connection.
 *
 * Nothing waits for it. The answer is what ends the exchange, and a body still
 * arriving when the answer goes out is what closing the connection is for.
 * @param req - the incoming request, whose body is read and dropped.
 * @param bound - how much of that body may be read, in bytes.
 */
function discardBody(req: IncomingMessage, bound: number): void {
  let size = 0
  const onData = (chunk: Buffer): void => {
    size += chunk.length
    if (size <= bound) return
    req.off('data', onData)
    req.pause()
  }
  req.on('data', onData)
}

/**
 * Answer a request whose body the route never read, dropping what its own bound
 * allows of that body first.
 *
 * Both halves bound the refusal, and neither one does it alone.
 * {@link discardBody} is what keeps node from draining the rest off the wire on
 * its own: closing the connection does not stop that drain, because node has
 * already resumed the request by the time the socket goes, and the drain then
 * outruns any bound the route holds. `connection: close` is what bounds what
 * the socket takes once the count has stopped, because node destroys the socket
 * as soon as the answer has flushed. What this process reads is therefore the
 * bound plus whatever the socket already held — against the whole body, which
 * is what an answer written over an unconsumed body costs.
 * @param req - the incoming request, whose body is dropped to the bound.
 * @param res - the response.
 * @param status - the HTTP status.
 * @param body - the document to serialize.
 * @param bound - how much of the refused body may be read, in bytes.
 */
export function refuseUnread(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  bound: number,
): void {
  discardBody(req, bound)
  answerClosing(res, status, body)
}

/**
 * Answer a request whose method the route does not serve.
 * @param req - the incoming request, whose body is dropped to the bound.
 * @param res - the response.
 * @param allow - the complete method set this exact path serves.
 * @param bound - how much of the refused body may be read, in bytes.
 */
export function rejectMethod(req: IncomingMessage, res: ServerResponse, allow: string, bound: number): void {
  discardBody(req, bound)
  // `allow` because these routes own their exact paths: nothing else can answer
  // the method the caller asked for, so the response states the complete set.
  // `connection: close` for the reason {@link refuseUnread} states: this answer
  // is written over a body the route never read.
  res.writeHead(405, { allow, connection: 'close' })
  res.end()
}

/**
 * Refuse a post a browser labelled cross-site, or one that is not sent as JSON.
 * Applied before the body is read, so both refusals drop it and close the
 * connection.
 *
 * The content-type test is a case-insensitive prefix match on
 * `application/json`. What it admits is neither a superset nor a subset of the
 * JSON media types: `application/jsonfoobar` passes and is no kind of JSON,
 * while `application/ld+json` and `application/merge-patch+json` are refused
 * and are. The conclusion holds regardless, because the CORS-simple content
 * types are exactly `text/plain`, `application/x-www-form-urlencoded` and
 * `multipart/form-data`, and none of the three begins with `application/json`
 * — so every request this admits costs a cross-origin poster a preflight, which
 * is what withdraws these routes from what a page can post to unasked.
 * @param req - the incoming request.
 * @param res - the response, answered here when the request is refused.
 * @param route - the route naming itself in the refusal.
 * @param bound - how much of a refused body may be read, in bytes.
 * @returns true when the request was refused and the handler must stop.
 */
export function rejectUntrustedPost(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  bound: number,
): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    refuseUnread(req, res, 403, { error: `content-frame: ${route} serves same-site requests only` }, bound)
    return true
  }
  const contentType = req.headers['content-type']
  if (contentType === undefined || !contentType.toLowerCase().startsWith('application/json')) {
    refuseUnread(req, res, 415, { error: `content-frame: ${route} accepts application/json only` }, bound)
    return true
  }
  return false
}

/**
 * What one bounded read of a request body ended as.
 *
 * {@link takeJsonBody} answers the two refusals and reads `value` off what is
 * left, so a member added here without an answer there would be taken for a
 * decoded document — silently, if it carries a `value` of its own. The
 * annotation on that last step is what refuses it.
 */
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
 * the body unconsumed, and node drains a body nothing consumed off the wire
 * itself once the exchange finishes — so refusing a request for its size would
 * still cost its size. Reading up to the bound and stopping there is what keeps
 * that drain from running: at the first chunk that crosses, the read drops its
 * data listener and pauses the request. It does not destroy the request,
 * because the route still has a refusal to write; closing the connection
 * belongs to that answer.
 *
 * The total counts each chunk's bytes after it has been decoded as UTF-8, which
 * is never fewer than the bytes that arrived — an invalid byte decodes to a
 * three-byte replacement character — so the bound only ever binds tighter than
 * the wire.
 *
 * The read has no deadline of its own: a caller that sends headers and then
 * stops mid-body leaves it unsettled until node's own `requestTimeout` ends the
 * exchange.
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
 * The 413 closes the connection because the read stopped at the bound: what is
 * left of the body may already be buffered or may still be arriving, and both
 * are handled as a body this exchange did not finish. The 400 for a body that
 * arrived in full and is not JSON is the same answer a well-formed body of the
 * wrong shape gets, and leaves the connection alive.
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
    answerClosing(res, 413, { error: refusals.oversize })
    return undefined
  }
  if (read.kind === 'not-json') {
    answerJson(res, 400, { error: refusals.shape })
    return undefined
  }
  // Annotated rather than inferred: a member added to `BodyRead` carrying a
  // `value` of its own would otherwise be read here as a decoded document.
  const decoded: Extract<BodyRead, { kind: 'json' }> = read
  return { value: decoded.value }
}
