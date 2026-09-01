/**
 * The plumbing both read routes share: method gating, the same-site JSON fence,
 * a bounded body reader, and the one JSON answer form.
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
 * Answer a request whose method the route does not serve.
 * @param res - the response.
 * @param allow - the complete method set this exact path serves.
 */
export function rejectMethod(res: ServerResponse, allow: string): void {
  // `allow` because these routes own their exact paths: nothing else can answer
  // the method the caller asked for, so the response states the complete set.
  res.writeHead(405, { allow })
  res.end()
}

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
 * Refuse a post a browser labelled cross-site, or one that is not sent as JSON.
 * Applied before the body is read.
 *
 * The content-type test is a prefix match, so a structured suffix such as
 * `application/json-patch+json` passes it too. That is the property being
 * asked for: no member of the `application/json` family is a CORS-simple
 * content type, so every one of them costs a cross-origin poster a preflight,
 * which is what withdraws these routes from what a page can post to unasked.
 * @param req - the incoming request.
 * @param res - the response, answered here when the request is refused.
 * @param route - the route naming itself in the refusal.
 * @returns true when the request was refused and the handler must stop.
 */
export function rejectUntrustedPost(req: IncomingMessage, res: ServerResponse, route: string): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    answerJson(res, 403, { error: `content-frame: ${route} serves same-site requests only` })
    return true
  }
  const contentType = req.headers['content-type']
  if (contentType === undefined || !contentType.toLowerCase().trimStart().startsWith('application/json')) {
    answerJson(res, 415, { error: `content-frame: ${route} accepts application/json only` })
    return true
  }
  return false
}

/**
 * Read one request body, refusing anything past the bound rather than holding it.
 *
 * A declared length past the bound is refused without reading a byte; a chunked
 * body declares none, so the running total stands in and stops the read at the
 * first chunk that crosses. Neither path destroys the request: the refusal is
 * written on the response and node finishes with the unread remainder itself,
 * where destroying the request would take that refusal down with it.
 * @param req - the incoming request.
 * @param limit - largest accepted body in bytes.
 * @returns the decoded JSON, or `undefined` when the body is oversized or not JSON.
 */
export async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  // A missing header makes this `Number(undefined)`, which is NaN, and no
  // comparison against NaN holds — so a chunked body falls through to the
  // running total instead of being refused for declaring nothing.
  if (Number(req.headers['content-length']) > limit) return undefined
  req.setEncoding('utf8')
  let text = ''
  let size = 0
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk as string)
    if (size > limit) return undefined
    text += chunk as string
  }
  try {
    return JSON.parse(text) as unknown
  } catch (_bodyIsNotJson) {
    // The only thing a malformed body can mean here is a caller that is not
    // this package's browser half; the 400 the caller gets says so.
    return undefined
  }
}
