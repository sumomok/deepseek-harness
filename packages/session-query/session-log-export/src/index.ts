/** Session-log download command and Host-owned streaming route. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-attachment'
import type { PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  measureSessionLogZip,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogCompressionLevel,
  type SessionLogExportReady,
} from './archive.ts'
import {
  SESSION_EXPORT_BYTES_HEADER,
  SESSION_EXPORT_ENTRIES_HEADER,
  SESSION_EXPORT_ESTIMATED_WIRE_BYTES_HEADER,
  type SessionLogExportExtent,
} from './export-extent.ts'
import { SESSION_LOG_EXPORT_PATH } from './routes.ts'

export {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  measureSessionLogZip,
  readSessionLogText,
  serializeSessionLog,
  SESSION_LOG_FILENAME,
  sessionLogExportDeps,
  sessionLogZipEntries,
  sessionLogZipFilename,
  streamSessionLogZip,
} from './archive.ts'
export type {
  SessionLogCompressionLevel,
  SessionLogExportDeps,
  SessionLogExportReady,
  SessionLogZipEntry,
} from './archive.ts'
export {
  SESSION_EXPORT_BYTES_HEADER,
  SESSION_EXPORT_ENTRIES_HEADER,
  SESSION_EXPORT_ESTIMATED_WIRE_BYTES_HEADER,
} from './export-extent.ts'
export type { SessionLogExportExtent } from './export-extent.ts'

export const name = 'session-log-download'
export const inject = ['commands', 'connection']

export { SESSION_LOG_EXPORT_PATH } from './routes.ts'

/** Session-log archive policy. */
export interface Config {
  /** DEFLATE level for each ZIP entry. @default 6 */
  readonly compressionLevel?: SessionLogCompressionLevel
}

/** Validate Session-log archive configuration. */
export const Config: Schema<Config> = Schema.object({
  compressionLevel: Schema.number().step(1).min(0).max(9)
    .default(DEFAULT_SESSION_LOG_COMPRESSION_LEVEL) as Schema<SessionLogCompressionLevel>,
})

interface SessionLogConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
      readonly serveNonOwner: (request: Request, peer: PeerScope) => Promise<Response>
    }): () => Promise<void>
  }
}

const REQUESTED: CommandResult = {
  kind: 'success',
  text: 'Session log download requested.',
}

/**
 * Register the Web-only `/export` command and authenticated ZIP download route.
 * @param ctx - Host context carrying the human-command registry.
 * @param config - resolved compression policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => ctx.commands.register({
    definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-session-log-export'),
    name: 'export',
    description: 'Download this Session log as a ZIP archive',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? REQUESTED
      : { kind: 'error', text: 'The Web /export command does not accept a path.' }),
  }), 'session-log-download: command')
  const fetch = async (request: Request): Promise<Response> => {
    const response = await sessionLogExportResponse(
      ctx,
      request,
      config.compressionLevel ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
    )
    if (request.method === 'GET') return response
    await response.body?.cancel()
    return new Response(null, { status: response.status, headers: response.headers })
  }
  connectionOf(ctx).fetch.register({
    path: SESSION_LOG_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch,
    serveNonOwner: async (request, peer) => await exportsAllowed(ctx, request, peer) ? fetch(request) : forbidden(),
  })
}

function forbidden(): Response {
  return new Response('forbidden', { status: 403 })
}

/**
 * Whether remote access allows a non-owner Peer to export what the request
 * names: the action `SESSION_LOG_EXPORT_PATH` on the requested Session and,
 * with `includeDescendants=true`, on every subagent descendant the archive
 * would include. The requested Session is decided before any lineage read.
 * @returns false for a missing `sessionId`, a Host without remote access or
 * Session query, an unreadable lineage, or any denial.
 */
async function exportsAllowed(ctx: Context, request: Request, peer: PeerScope): Promise<boolean> {
  const query = new URL(request.url).searchParams
  const requested = query.get('sessionId')
  const remoteAccess = ctx.get('remoteAccess')
  if (requested === null || requested === '' || remoteAccess === undefined) return false
  const allowed = (ids: readonly SessionId[]): boolean => remoteAccess.decide({
    principal: peer.principal,
    action: SESSION_LOG_EXPORT_PATH,
    resources: ids.map(id => ({ kind: 'session', id })),
  }).kind === 'allow'
  const sessionId = brandString<SessionId>(requested)
  if (!allowed([sessionId])) return false
  if (query.get('includeDescendants') !== 'true') return true
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery === undefined) return false
  let descendants: readonly SessionLineageNode[]
  try {
    descendants = (await sessionQuery.traceSession(sessionId, request.signal)).descendants
  } catch {
    // A lineage this route cannot read is not shown to be allowed; the owner's path reports such failures.
    request.signal.throwIfAborted()
    return false
  }
  const ids: SessionId[] = []
  const collect = (nodes: readonly SessionLineageNode[]): void => {
    for (const node of nodes) {
      ids.push(node.session.header.id)
      collect(node.descendants)
    }
  }
  collect(descendants)
  return ids.length === 0 || allowed(ids)
}

function connectionOf(ctx: Context): SessionLogConnection {
  return Reflect.get(ctx, 'connection') as SessionLogConnection
}

async function sessionLogExportResponse(
  ctx: Context,
  request: Request,
  compressionLevel: SessionLogCompressionLevel,
): Promise<Response> {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams)
  const sessionIdValue = query['sessionId']
  const descendantsValue = query['includeDescendants']
  if (sessionIdValue === undefined || sessionIdValue.length === 0
    || (descendantsValue !== undefined && descendantsValue !== 'true' && descendantsValue !== 'false')) {
    return new Response('missing or invalid sessionId query parameter', { status: 400 })
  }
  const sessionId = brandString<SessionId>(sessionIdValue)
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionQuery === undefined
    || deps.sessionPersistence === undefined
    || deps.attachments === undefined) {
    return new Response(
      'session log export is unavailable: missing session-query, session-persistence, or attachments service',
      { status: 500 },
    )
  }
  const ready: SessionLogExportReady = {
    sessionQuery: deps.sessionQuery,
    sessionPersistence: deps.sessionPersistence,
    attachments: deps.attachments,
    sessions: deps.sessions,
  }
  let rootContent: string | undefined
  try {
    await flushLiveSessionLog(deps, sessionId, request.signal)
    rootContent = await readSessionLogText(deps.sessionPersistence, sessionId, request.signal)
    request.signal.throwIfAborted()
  } catch {
    request.signal.throwIfAborted()
    // Root preparation failure (flush, open, or read): answer 500 without
    // echoing the error, which may carry absolute host paths into the
    // browser error bar.
    return new Response('session log export failed to read the stored log', { status: 500 })
  }
  if (rootContent === undefined) {
    return new Response('session not found', { status: 404 })
  }
  const includeDescendants = descendantsValue === 'true'
  let extent: SessionLogExportExtent | undefined
  try {
    extent = await measureSessionLogZip(
      ready, rootContent, sessionId, includeDescendants, compressionLevel, request.signal,
    )
  } catch {
    // Measuring walks the same lineage and the same persistence reads the
    // producer walks, so every failure reachable here — a missing descendant
    // log, an unreadable handle, a lineage error — is reached again by the
    // stream, which owns the outcome and errors the response body rather than
    // shipping a truncated archive. Measuring never reads a stored image, so
    // an unreadable attachment never reaches here; the stream records that one
    // inside the archive and still completes. Swallowing a measurement failure
    // only drops the browser to an indeterminate progress bar; cancellation is
    // not a measurement failure and is rethrown.
    request.signal.throwIfAborted()
  }
  return new Response(
    streamSessionLogZip(
      ready,
      rootContent,
      sessionId,
      includeDescendants,
      compressionLevel,
      request.signal,
    ),
    {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
        ...extent === undefined ? {} : {
          [SESSION_EXPORT_ENTRIES_HEADER]: String(extent.entries),
          [SESSION_EXPORT_BYTES_HEADER]: String(extent.bytes),
          [SESSION_EXPORT_ESTIMATED_WIRE_BYTES_HEADER]: String(extent.estimatedWireBytes),
        },
      },
    },
  )
}
