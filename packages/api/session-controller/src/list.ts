/** Cold-safe Session list and search projection. */

import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
// Type-only: merges the command lifecycle events into SessionEventMap so the
// blank fold can name `command/run`.
import type {} from '@deepseek-ai/dsh-commands/types'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import {
  SessionQueryError,
  type SessionRecord,
  type SessionSearchCursor,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './types.ts'
import type {
  SessionListMetadata, SessionMessageMatchRange, SessionMessageSearchItem, SessionMessageSearchRequest,
  SessionMessageSearchValue,
  SessionProjectionHints, SessionSearchItem,
  SessionSearchValue, SessionSummary,
} from './types.ts'

/**
 * Keep only the matched spans that still index the excerpt after truncation.
 *
 * The provider reports offsets into the excerpt it returned; the Host bounds
 * that excerpt again, so a span past the cut would index past the string.
 * @param snippet - the excerpt this response will carry.
 * @param matches - spans the provider reported against its own excerpt.
 * @returns the surviving spans, or undefined when there were none to begin with.
 */
function boundedMatches(
  snippet: string,
  matches: readonly SessionMessageMatchRange[] | undefined,
): readonly SessionMessageMatchRange[] | undefined {
  if (matches === undefined) return undefined
  return matches
    .map(range => ({ start: range.start, length: Math.min(range.length, snippet.length - range.start) }))
    .filter(range => range.start >= 0 && range.length > 0)
}

const SEARCH_PROVIDER_CALL_LIMIT = 100

/** One admitted search hit and the key that keeps it unique across pages. */
interface AdmittedHit<TItem> {
  /** Identity of the provider row this item came from. */
  readonly key: string
  /** The item this search returns for that row. */
  readonly item: TItem
}
const SESSION_SEARCH_QUERY_MAX_CHARS = 500
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

const imageLimitsSchema = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxImageDimension: z.number().int().positive(),
  mediaTypes: z.array(z.string()),
}) as unknown as z.ZodType<ImageAttachmentLimits>

/**
 * Advance the Session-list metadata projection by one committed event.
 *
 * `blank` means the Session has nothing to show and nothing to address: it
 * falls on the first `turn/start` and on the first engaging `command/run`,
 * and never rises again. A command run counts unless it recorded
 * `engages: false`, the declaration a command makes when it configures the
 * session instead of contributing to the conversation; the member is absent
 * on every ordinary run and on every log written before the declaration
 * existed. The remaining standalone events (`plan/mode`, `session/title`,
 * permission and sandbox configuration) never clear it: they record a
 * setting, not content.
 * @param state - metadata before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced metadata value.
 */
export function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank
    && event.type !== 'turn/start'
    && !(event.type === 'command/run' && event.data.engages !== false)
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - source text.
 * @param maximum - maximum number of Unicode code points.
 * @returns the source text or its longest allowed prefix.
 */
export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count++
    end += codePoint.length
  }
  return value
}

/** Owns list projection registration, bounded cold summaries, and authorized search. */
export class ApiSessionList {
  /**
   * @param ctx - Host context carrying Session, query, persistence, and projection services.
   * @param workSliceMs - Resolved positive integral list-work budget in milliseconds.
   */
  constructor(private readonly ctx: Context, private readonly workSliceMs: number) {}

  /**
   * Acquire projection readers before exposing dependent operations.
   * @returns when all required registrations are ready.
   */
  async initialize(): Promise<void> {
    await this.ctx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata',
      stateSchema: sessionListMetadataSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      wire: { viewSchema: sessionListMetadataSchema, view: state => state },
      // Held at 1 although the fold changed. The unit carries `blank` and
      // `lastPromptAt` under one row version, and a discarded row is refolded
      // only for a Session that is opened again — `summarizeCold` serves the
      // list from cached rows alone. Bumping it would drop `lastPromptAt` for
      // every never-reopened Session, ordering and labelling the whole
      // sidebar by creation time, to correct a `blank` verdict on the
      // Sessions that ran a command before this build.
      stateVersion: 1,
    })
    await this.ctx.sessionProjections.register<'imageLimits', null>({
      key: 'imageLimits',
      stateSchema: z.null(),
      init: () => null,
      apply: state => state,
      wire: {
        viewSchema: imageLimitsSchema,
        view: () => this.ctx.attachments.imageLimits,
        summary: false,
      },
      stateVersion: 1,
    })
  }

  /**
   * Build one current attached-Session summary.
   * @param session - attached Session to summarize.
   * @returns current list metadata and available projections.
   */
  summaryFor(session: Session): SessionSummary {
    const projections = this.projectionsFor(session.header, session)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: session.id,
      updatedAt: updatedAt(session.header, metadata),
      agentAvailable: this.ctx.agents.get(session.id)?.session === session,
      formatStatus: 'current',
      running: this.ctx.agents.get(session.id)?.status === 'running',
      blank: metadata?.blank ?? session.seq === 0,
      ...listFields(session.header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Read every visible attached and persisted Session without activating an Agent.
   * @param signal - optional cancellation for persistence reads and summary generation.
   * @returns visible Session summaries ordered by activity.
   */
  async list(signal?: AbortSignal): Promise<SessionSummary[]> {
    signal?.throwIfAborted()
    const records = await this.ctx.sessionQuery.listSessions(signal)
    signal?.throwIfAborted()
    const items: SessionSummary[] = []
    const cold: SessionRecord[] = []
    let yieldDeadline = performance.now() + this.workSliceMs
    for (const record of records) {
      signal?.throwIfAborted()
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) {
        items.push(this.summaryFor(live))
      } else if (record.header.cwd !== undefined) {
        cold.push(record)
      }
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + this.workSliceMs
      }
    }
    for (const record of cold) {
      signal?.throwIfAborted()
      items.push(this.summarizeCold(record))
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + this.workSliceMs
      }
    }
    signal?.throwIfAborted()
    items.sort((left, right) => right.updatedAt - left.updatedAt)
    return items
  }

  private summarizeCold({ header, formatStatus }: SessionRecord): SessionSummary {
    const projections = this.projectionsFor(header, undefined)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: header.id,
      updatedAt: updatedAt(header, metadata),
      agentAvailable: false,
      ...(formatStatus === undefined ? {} : { formatStatus }),
      running: false,
      // A large, metadata-less, or inaccessible cache miss remains unknown and visible.
      blank: metadata?.blank ?? false,
      ...listFields(header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Search current visible message content without activating any matching Session.
   * @param query - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  async search(query: string, signal: AbortSignal): Promise<SessionSearchValue> {
    const { provider, visibleIds } = await this.searchContext(signal)
    if (visibleIds.size === 0) return { items: [], hasMore: false }
    return this.collectSearchHits(
      query,
      signal,
      (request, exec) => provider.searchSessions(request, exec),
      (hit: SessionSearchHit): AdmittedHit<SessionSearchItem> | undefined => {
        if (!visibleIds.has(hit.header.id)
          || hit.bestMatch.sessionId !== hit.header.id
          || hit.bestMatch.surface !== 'current'
          || !MESSAGE_TYPES.has(hit.bestMatch.type)) return undefined
        return {
          key: hit.header.id,
          item: {
            sessionId: hit.header.id,
            snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
          },
        }
      },
    )
  }

  /**
   * Return one page of current visible message content, addressed by event.
   *
   * {@link search} answers "which Sessions match", which cannot open anything:
   * its page groups events and keeps one strong hit per Session. This returns
   * the events themselves under the provider's own continuation cursor, so a
   * caller can open the message a snippet came from and ask for the next page
   * without the Host holding a result set it cannot bound.
   *
   * Admission runs after the provider page is read, so a page can arrive with
   * fewer items than it asked for while still carrying a continuation cursor.
   * @param request - literal message-content query and an optional cursor.
   * @param signal - cancellation for list and search reads.
   * @returns this page's authorized hits and the cursor for the next one.
   */
  async searchMessages(request: SessionMessageSearchRequest, signal: AbortSignal): Promise<SessionMessageSearchValue> {
    const { provider, visibleIds } = await this.searchContext(signal)
    if (visibleIds.size === 0) return { items: [] }
    const normalizedQuery = normalizeSearchQuery(request.query)
    const cursor = request.cursor
    signal.throwIfAborted()
    try {
      let pageLimit = SESSION_SEARCH_RESULT_LIMIT
      while (true) {
        signal.throwIfAborted()
        let page
        try {
          page = await provider.searchMessages({
            query: normalizedQuery,
            eventFilters: [
              { kind: 'type', values: ['user/message', 'assistant/message'] },
              { kind: 'surface', values: ['current'] },
            ],
            limit: pageLimit,
            ...(cursor === undefined ? {} : { cursor }),
          }, { signal })
          signal.throwIfAborted()
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (cursor === undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_INVALID_LIMIT'
            && pageLimit > 1) {
            pageLimit = Math.max(1, Math.floor(pageLimit / 2))
            continue
          }
          throw error
        }
        if (page.items.length > pageLimit) {
          throw new Error(`session search provider returned ${String(page.items.length)} items; maximum is ${String(pageLimit)}`)
        }
        const items: SessionMessageSearchItem[] = []
        const accepted = new Set<string>()
        for (const hit of page.items) {
          if (!visibleIds.has(hit.sessionId)
            || hit.surface !== 'current'
            || !MESSAGE_TYPES.has(hit.type)) continue
          const address = `${hit.sessionId}:${String(hit.seq)}`
          if (accepted.has(address)) continue
          accepted.add(address)
          const snippet = truncateUnicodeCodePoints(hit.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS)
          items.push({
            sessionId: hit.sessionId,
            seq: hit.seq,
            snippet,
            ...boundedMatches(snippet, hit.matches) === undefined
              ? {}
              : { matches: boundedMatches(snippet, hit.matches) ?? [] },
          })
        }
        return {
          items,
          ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
          ...page.coverage === undefined
            ? {}
            : { coverage: { status: page.coverage.status, skippedSessions: page.coverage.skippedSessions } },
        }
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SessionQueryError) {
        if (error.code === 'SESSION_QUERY_ABORTED') {
          throw new RemoteError('gateway/cancelled', 'session search was aborted', {})
        }
        if (error.code === 'SESSION_QUERY_STALE_CURSOR') {
          throw new RemoteError(
            'gateway/bad-request',
            'session search cursor outlived its index generation; restart from the first page',
            {},
          )
        }
      }
      throw new RemoteError('gateway/internal', `session search failed: ${String(error)}`, {})
    }
  }

  /**
   * Resolve the mounted query service and the Sessions this caller may see.
   * @param signal - cancellation for the listing read.
   * @returns the provider and the ids every hit is checked against.
   */
  private async searchContext(signal: AbortSignal): Promise<{
    provider: SessionQueryEngine
    visibleIds: Set<SessionId>
  }> {
    signal.throwIfAborted()
    const provider = this.ctx.get('sessionQuery')
    if (provider === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
        {},
      )
    }
    const visible = await provider.listSessions(signal)
    signal.throwIfAborted()
    return {
      provider,
      visibleIds: new Set(visible
        .filter(record => record.header.cwd !== undefined)
        .map(record => record.header.id)),
    }
  }

  /**
   * Collect bounded hits from one cursor-paged provider search.
   *
   * Both entry points share one work budget, one limit-degradation ladder, one
   * stale-cursor restart, and one repetition check; only the provider call and
   * the per-hit admission differ, so those arrive as arguments.
   * @param query - literal message-content query.
   * @param signal - cancellation for the reads behind this page sequence.
   * @param fetchPage - calls the provider method this search reads from.
   * @param admit - projects one provider hit, or rejects it with undefined.
   * @returns admitted items and whether the provider held more than the limit.
   */
  private async collectSearchHits<TRow, TItem>(
    query: string,
    signal: AbortSignal,
    fetchPage: (
      request: SessionSearchRequest,
      exec: { signal: AbortSignal },
    ) => Promise<SessionSearchPage<TRow>>,
    admit: (row: TRow) => AdmittedHit<TItem> | undefined,
  ): Promise<{ items: TItem[]; hasMore: boolean }> {
    const normalizedQuery = normalizeSearchQuery(query)
    signal.throwIfAborted()
    try {
      const authorized: TItem[] = []
      const accepted = new Set<string>()
      const seenCursors = new Set<SessionSearchCursor>()
      let cursor: SessionSearchCursor | undefined
      let providerCalls = 0
      let pageLimit = SESSION_SEARCH_RESULT_LIMIT
      while (authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
        signal.throwIfAborted()
        if (providerCalls >= SEARCH_PROVIDER_CALL_LIMIT) {
          throw new Error(`session search provider exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`)
        }
        providerCalls++
        const requestedCursor = cursor
        const requestedLimit = pageLimit
        let page
        try {
          page = await fetchPage({
            query: normalizedQuery,
            eventFilters: [
              { kind: 'type', values: ['user/message', 'assistant/message'] },
              { kind: 'surface', values: ['current'] },
            ],
            limit: requestedLimit,
            ...(requestedCursor === undefined ? {} : { cursor: requestedCursor }),
          }, { signal })
          signal.throwIfAborted()
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (requestedCursor === undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_INVALID_LIMIT'
            && requestedLimit > 1) {
            pageLimit = Math.max(1, Math.floor(requestedLimit / 2))
            continue
          }
          if (requestedCursor !== undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_STALE_CURSOR') {
            authorized.length = 0
            accepted.clear()
            seenCursors.clear()
            cursor = undefined
            continue
          }
          throw error
        }
        if (page.items.length > requestedLimit) {
          throw new Error(`session search provider returned ${String(page.items.length)} items; maximum is ${String(requestedLimit)}`)
        }
        for (const row of page.items) {
          if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue
          const admitted = admit(row)
          if (admitted === undefined || accepted.has(admitted.key)) continue
          accepted.add(admitted.key)
          authorized.push(admitted.item)
        }
        if (page.nextCursor !== undefined) {
          if (seenCursors.has(page.nextCursor)) {
            throw new Error('session search provider repeated a continuation cursor')
          }
          seenCursors.add(page.nextCursor)
        }
        if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return {
        items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
        hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT,
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'session search was aborted', {})
      }
      throw new RemoteError('gateway/internal', `session search failed: ${String(error)}`, {})
    }
  }

  private projectionsFor(
    header: SessionHeader,
    session: Session | undefined,
  ): SessionProjectionHints | undefined {
    try {
      // The registry derives the summary key set from its registrations and
      // hands back one stable set until the key table changes; both faces below
      // serve only those keys, so a list row cannot carry a unit that declares
      // itself summary-excluded.
      const keys = this.ctx.sessionProjections.summaryKeys()
      if (session !== undefined) {
        // The live registry computed the block for this Session: its watermark
        // shares the sequence space of the Session's baselines and frames.
        return hintsOf('sequenced', this.ctx.sessionProjections.cachedSnapshot(session, keys))
      }
      // A cold row reads the persisted cache by header alone; the cache serves
      // seeded and unseeded lifecycles alike because a listing never seeds a
      // fold. The watermark is the stored record's own.
      const cache = this.ctx.get('sessionProjectionCache')
      return hintsOf('cached', cache?.cachedSnapshot(header, keys) ?? cache?.cachedPredecessorTitle(header))
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: projection column for "${header.id}" failed; serving the row without it: ${String(error)}`,
      )
      return undefined
    }
  }
}

/**
 * Wrap one summary projection block as Session-list hints of the named sequence space.
 * The block is the summary key set's values, not every value the source holds.
 * @param kind - which sequence space the block's watermark belongs to.
 * @param block - the block, or `undefined` when no source served one.
 * @returns the hints, or `undefined` when the block is absent or carries no value.
 */
function hintsOf(
  kind: SessionProjectionHints['kind'],
  block: ProjectionSnapshot | undefined,
): SessionProjectionHints | undefined {
  if (block === undefined || Object.keys(block.values).length === 0) return undefined
  // Listing hints contain every summary wire value the source currently holds
  // but remain partial: missing cells and cache rows are never materialized here.
  return { kind, asOfSeq: block.asOfSeq, values: block.values }
}

function normalizeSearchQuery(query: string): string {
  const normalized = query.trim()
  if (normalized.length === 0) {
    throw new RemoteError('gateway/bad-request', 'session search query must not be empty', {})
  }
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new RemoteError(
      'gateway/bad-request',
      `session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`,
      {},
    )
  }
  if (normalized.includes('\0')) {
    throw new RemoteError('gateway/bad-request', 'session search query must not contain NUL', {})
  }
  return normalized
}

function updatedAt(header: SessionHeader, metadata: SessionListMetadata | undefined): number {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}

function listFields(header: SessionHeader): {
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
} {
  return {
    ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  }
}
