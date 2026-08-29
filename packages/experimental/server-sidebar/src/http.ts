/**
 * Response and request helpers for the favorites route: the JSON answer
 * form, the two refusals that fence the mutating method to same-site JSON,
 * and the bounded reader its body is read through.
 *
 * A near-duplicate of `@deepseek-ai/dsh-experimental-auth-gate`'s own
 * `src/http.ts`, kept as a separate small copy rather than an import: a
 * cross-package value import is not this repository's sanctioned way to
 * couple two client-adjacent plugins (see `packages/client/AGENTS.md`'s
 * export-discipline section), and these functions are generic enough that
 * duplicating them costs less than inventing a shared seam neither package
 * currently needs for anything else.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/src/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/* jscpd:ignore-start -- a near-duplicate of dsh-experimental-auth-gate's own
 * src/http.ts, kept as a separate copy rather than an import (see this
 * file's module doc for why).
 */

/**
 * Answer one JSON document with no caching; both favorites responses serve
 * request-local truth.
 * @param res - the response to write.
 * @param status - the status code to answer with.
 * @param body - the document to serialize.
 */
export function answerJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Answer a request whose method the route does not serve, stating the
 * complete set it does.
 * @param res - the response to write.
 * @param allow - the complete method set, as the `Allow` header carries it.
 */
export function rejectMethod(res: ServerResponse, allow: string): void {
  res.writeHead(405, { allow })
  res.end()
}

/**
 * Refuse a request a browser labelled cross-site. Applied to the mutating
 * method before its body is read: an arbitrary page must not be able to
 * rewrite what this deployment's user has favorited.
 * @param req - the incoming request.
 * @param res - the response, answered here when the request is refused.
 * @param what - the route named in the refusal.
 * @returns true when the request was refused and the handler must stop.
 */
export function rejectCrossSite(req: IncomingMessage, res: ServerResponse, what: string): boolean {
  if (req.headers['sec-fetch-site'] !== 'cross-site') return false
  answerJson(res, 403, { error: `server-sidebar: the ${what} serves same-site requests only` })
  return true
}

/**
 * Refuse a request that does not declare a JSON body. Requiring the content
 * type withdraws the route from the CORS-simple set a cross-origin page can
 * post without a preflight.
 * @param req - the incoming request.
 * @param res - the response, answered here when the request is refused.
 * @param what - the route named in the refusal.
 * @returns true when the request was refused and the handler must stop.
 */
export function rejectNonJson(req: IncomingMessage, res: ServerResponse, what: string): boolean {
  const declared = req.headers['content-type']?.toLowerCase().trimStart()
  if (declared?.startsWith('application/json') === true) return false
  answerJson(res, 415, { error: `server-sidebar: the ${what} accepts application/json only` })
  return true
}

/**
 * Read one request body as text, stopping at the bound rather than buffering
 * past it.
 * @param req - the incoming request.
 * @param limit - largest accepted body, in characters.
 * @returns the body text, or `undefined` once the bound is passed.
 */
export async function readBoundedText(req: IncomingMessage, limit: number): Promise<string | undefined> {
  req.setEncoding('utf8')
  let text = ''
  for await (const chunk of req) {
    text += chunk as string
    if (text.length > limit) return undefined
  }
  return text
}

/* jscpd:ignore-end */
