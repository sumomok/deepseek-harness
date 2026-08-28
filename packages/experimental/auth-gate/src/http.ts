/**
 * Response and request helpers shared by this package's routes: the JSON answer
 * form, the two refusals that fence a route to same-site JSON, and the bounded
 * reader the token route takes its body through.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Answer one JSON document with no caching; every route here serves
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
 * Answer a request whose method the route does not serve, stating the complete
 * set it does.
 * @param res - the response to write.
 * @param allow - the complete method set, as the `Allow` header carries it.
 */
export function rejectMethod(res: ServerResponse, allow: string): void {
  // `allow` because these routes own their paths outright: nothing else can
  // answer the method the caller asked for, so the response states the whole set.
  res.writeHead(405, { allow })
  res.end()
}

/**
 * Refuse a request a browser labelled cross-site. Applied before the body is
 * read, and before any credential is put to work: the token route takes a
 * credential and the forwarding routes spend one, so neither may be a document
 * an arbitrary page can post to. `cross-site` is the same marker the shell's own
 * `/api` fence refuses (`dsh-client-connection`'s `api-request-trust.ts`).
 * @param req - the incoming request.
 * @param res - the response, answered here when the request is refused.
 * @param what - the route named in the refusal.
 * @returns true when the request was refused and the handler must stop.
 */
export function rejectCrossSite(req: IncomingMessage, res: ServerResponse, what: string): boolean {
  if (req.headers['sec-fetch-site'] !== 'cross-site') return false
  answerJson(res, 403, { error: `auth-gate: the ${what} serves same-site requests only` })
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
  answerJson(res, 415, { error: `auth-gate: the ${what} accepts application/json only` })
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
