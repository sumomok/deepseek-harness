/**
 * The two response forms this package's routes answer with.
 *
 * A deliberate small copy of `@deepseek-ai/dsh-experimental-component-surface`'s
 * own `src/http.ts` rather than an import, on the reasoning that file already
 * records: a cross-package value import is not this repository's sanctioned
 * way to couple two client-adjacent plugins, and two four-line answers cost
 * less than a shared seam neither package needs for anything else. The copy is
 * declared to the clone detector through `.jscpd.json`'s ignore markers, which
 * is this repository's narrow exception for a copy that is meant to be one.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/http
 */

import type { ServerResponse } from 'node:http'

/* jscpd:ignore-start */

/**
 * Answer one JSON document with no caching. The settings are read once per boot
 * and carry the values the row booted with, and an ability table is one read of
 * the visitor's rights, so a cached copy of either would outlive its own truth.
 * @param res - the response to write.
 * @param status - the HTTP status.
 * @param body - the document to serialize.
 */
export function answerJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Answer a request whose method the route does not serve, stating the complete
 * set it does — which an exact route can, being the only thing that answers its
 * path, and which 405 requires.
 * @param res - the response to write.
 * @param allow - the complete method set, as the `Allow` header carries it.
 */
export function rejectMethod(res: ServerResponse, allow: string): void {
  res.writeHead(405, { allow })
  res.end()
}
/* jscpd:ignore-end */
