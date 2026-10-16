/**
 * Authenticated GET/HEAD /api/file reads bounded file responses through
 * the composed filesystem provider. For the owner, paths and MIME types do not
 * restrict access; the connection service authenticates requests before this
 * handler. A non-owner Peer reads only files inside the workspace of a Session
 * remote access grants it the route on.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-attachment'
import { FsError, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import mime from 'mime-types'

const FILE_ROUTE = '/api/file'

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  // HTML and SVG files may be opened directly on the authenticated API origin.
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

/**
 * Serve one file. `confinedTo`, given only for a non-owner Peer, names the
 * canonical directory the file must lie in; the containment check and the read
 * use the same resolved target.
 */
async function serveFile(
  request: Request,
  fs: FileSystem,
  maxBytes: number,
  confinedTo?: () => Promise<FsTarget | undefined>,
): Promise<Response> {
  const fail = (status: number, text: string): Response =>
    new Response(request.method === 'HEAD' ? null : text, { status, headers: BASE_HEADERS })
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path.length === 0) return fail(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return fail(400, 'absolute path required')
  try {
    const root = confinedTo === undefined ? undefined : await confinedTo()
    if (confinedTo !== undefined && root === undefined) return fail(403, 'forbidden')
    const target = await fs.resolve(path, { signal: request.signal })
    if (root !== undefined && !fs.contains(root, target)) return fail(403, 'forbidden')
    const mediaType = mime.lookup(target.displayPath) || 'application/octet-stream'
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': mediaType,
    }
    if (request.method === 'HEAD') {
      const info = await fs.stat(target, request.signal)
      if (info === undefined) return fail(404, 'not found')
      if (info.type !== 'file') return fail(403, 'not a regular file')
      if (info.size !== undefined) {
        if (info.size > maxBytes) return fail(413, 'file exceeds byte limit')
        headers['Content-Length'] = String(info.size)
      }
      return new Response(null, { headers })
    }
    const bytes = await fs.readBytes(target, request.signal, maxBytes)
    headers['Content-Length'] = String(bytes.byteLength)
    return new Response(bytes.slice(), { headers })
  } catch (error: unknown) {
    if (!(error instanceof FsError)) throw error
    const statuses: Partial<Record<FsError['code'], number>> = {
      FS_NOT_FOUND: 404,
      FS_NOT_REGULAR_FILE: 403,
      FS_PERMISSION_DENIED: 403,
      FS_SANDBOX_DENIED: 403,
      FS_TOO_LARGE: 413,
      FS_ABORTED: 499,
    }
    return fail(statuses[error.code] ?? 500, error.code)
  }
}

/**
 * Serve a non-owner Peer only a file of a Session on which remote access
 * allows the route: the request names the Session in `sessionId`, and the
 * file's canonical path must lie inside that Session's workspace, its header
 * `cwd`. Everything else answers 403 before the file is resolved or read.
 */
function serveNonOwnerFile(ctx: Context, request: Request, peer: PeerScope, maxBytes: number): Promise<Response> {
  const requested = new URL(request.url).searchParams.get('sessionId')
  const sessionId = requested === null || requested === '' ? undefined : brandString<SessionId>(requested)
  const allowed = sessionId !== undefined && ctx.get('remoteAccess')?.decide({
    principal: peer.principal,
    action: FILE_ROUTE,
    resources: [{ kind: 'session', id: sessionId }],
  }).kind === 'allow'
  if (!allowed) {
    return Promise.resolve(new Response(request.method === 'HEAD' ? null : 'forbidden', { status: 403, headers: BASE_HEADERS }))
  }
  return serveFile(request, ctx.fs, maxBytes, async () => {
    const live = ctx.get('sessions')?.get(sessionId)?.header
    const cwd = (live ?? (await ctx.get('sessionPersistence')?.stat(sessionId))?.header)?.cwd
    return cwd === undefined ? undefined : await ctx.fs.resolve(cwd, { signal: request.signal })
  })
}

/**
 * File-display contribution. The connection service supplies authentication;
 * `ctx.fs` supplies the execution world's paths, reads, and access policy.
 */
export const SessionMediaReferences = {
  inject: ['connection', 'fs', 'attachments'],
  apply(ctx: Context): void {
    const maxBytes = ctx.attachments.imageLimits.maxImageBytes
    ctx.effect(() => ctx.connection.fetch.register({
      path: FILE_ROUTE,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => serveFile(request, ctx.fs, maxBytes),
      serveNonOwner: (request, peer) => serveNonOwnerFile(ctx, request, peer, maxBytes),
    }), 'session-controller: /api/file')
  },
}
