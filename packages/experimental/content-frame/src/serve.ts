/**
 * Static serving for one hosted application root. The webserver's fallback
 * owner already serves the dsh SPA dist; this file exists because a hosted
 * application needs the two semantics that owner deliberately does not have:
 * a miss is a loud 404 instead of the dsh index at HTTP 200, and the content
 * type table covers what a real web application ships rather than the seven
 * kinds a dsh build emits.
 */

import type { ServerResponse } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

/**
 * Content types this route answers with. A wrong type is a silent failure
 * inside the iframe — a font or an icon served as `application/octet-stream`
 * is dropped by the browser with no request-level error to read — so the table
 * covers every format a static build normally emits.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
}

/** Type for a file whose extension the table does not name. */
const UNKNOWN_MIME = 'application/octet-stream'

/** Entry document a directory request resolves to. */
const INDEX = 'index.html'

/**
 * Whether a path is the root itself or sits under it.
 * @param root - the containing directory, already real and absolute.
 * @param target - the path to test.
 * @returns true when target is inside root.
 */
function isInside(root: string, target: string): boolean {
  // `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  return target === root || target.startsWith(root + sep)
}

/** Answer with a status code and no body. */
function refuse(res: ServerResponse, status: number): void {
  res.writeHead(status)
  res.end()
}

/**
 * Resolve one request target to the file that answers it.
 * @param target - the lexically resolved path the request names.
 * @returns the real path to read, or undefined when nothing is there.
 */
async function locate(target: string): Promise<string | undefined> {
  const info = await stat(target).catch(() => undefined)
  if (info === undefined) return undefined
  // The real path, not the lexical one: a symlink inside the root may point
  // out of it, and the caller's containment check has to run on the file that
  // will actually be read. A directory with no index.html rejects here too.
  return await realpath(info.isDirectory() ? join(target, INDEX) : target).catch(() => undefined)
}

/**
 * Serve one GET/HEAD request from the hosted application root.
 * @param pathname - the decoded request path relative to the route prefix
 * (`''` and `'/'` both name the entry document).
 * @param res - the node:http response to write.
 * @param root - absolute real path of the hosted application directory.
 */
export async function serveContentApp(pathname: string, res: ServerResponse, root: string): Promise<void> {
  const target = resolve(normalize(join(root, pathname)))
  if (!isInside(root, target)) {
    refuse(res, 403)
    return
  }
  const file = await locate(target)
  if (file === undefined) {
    // Loud 404. This route owns its whole prefix, so the miss never reaches the
    // webserver fallback — which would answer the iframe with the dsh shell at
    // HTTP 200 and hide the broken path from whoever deployed the application.
    refuse(res, 404)
    return
  }
  if (!isInside(root, file)) {
    refuse(res, 403)
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? UNKNOWN_MIME,
    // The hosted application is edited in place under a stable URL, so a cached
    // entry document would keep serving the previous build after a redeploy.
    'cache-control': 'no-cache',
  })
  res.end(await readFile(file))
}
