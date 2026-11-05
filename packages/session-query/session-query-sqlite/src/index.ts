/**
 * Concrete session-query service with SQLite FTS5 over the live-preferred corpus.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite
 */

import { createHash, randomUUID } from 'node:crypto'
import { scheduler } from 'node:timers/promises'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import SessionQueryEngine, {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  SessionSearchCursor,
  assertSessionHeadersCompatible,
  buildSessionEventSearchDocuments,
  readColdSessionLog,
} from '@deepseek-ai/dsh-session-query'
import type {
  ColdSessionLog,
  Config as SessionQueryConfig,
  SessionEventSearchDocument,
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionMessageSearchRequest,
  SessionSearchCoverage,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchCursor as SessionSearchCursorValue,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  type JournalMode,
  openSearchDatabase,
} from './schema.ts'
import {
  type NormalizedEventRequest,
  type NormalizedSessionRequest,
  FTS_HIGHLIGHT_END,
  FTS_HIGHLIGHT_START,
  assertFts5OuterPredicateCount,
  assertPortableBindingCount,
  buildEventWhere,
  buildSessionWhere,
  compileMessageTerms,
  escapeLikeTerm,
  makeSnippet,
  markMessageMatches,
  normalizeEventRequest,
  normalizeSessionRequest,
  quoteFtsData,
  requestFingerprint,
  sanitizeFtsText,
  SQLITE_MAX_PAGE_LIMIT,
} from './query.ts'

export {
  SESSION_QUERY_SQLITE_APPLICATION_ID,
  SESSION_QUERY_SQLITE_INDEX_IDENTITY,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
  type JournalMode,
} from './schema.ts'

/** Boot-context slot for a launcher-owned absolute path to this process's derived query index. */
export const SESSION_QUERY_SQLITE_PATH_KEY = 'launcherSessionQueryPath'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned absolute path to this process's disposable derived query index. */
    launcherSessionQueryPath?: string
  }
}

/** Default result page size. */
export const SESSION_QUERY_SQLITE_DEFAULT_LIMIT = 20
/** Maximum accepted result page size. */
export const SESSION_QUERY_SQLITE_MAX_LIMIT = 100
/** Default maximum snippet length in Unicode code points. */
export const SESSION_QUERY_SQLITE_SNIPPET_CHARS = 240
/** Default number of stored Sessions one reconciliation decides between event-loop yields. */
export const SESSION_QUERY_SQLITE_DEFAULT_RECONCILE_BATCH_SIZE = 16

// One transient source change gets a retry; repeated churn fails rather than monopolizing the queue.
const STABLE_OBSERVATION_ATTEMPTS = 2

/** SQLite module/handle opening phase; `never` disables full-text search entirely. */
export type OpenAt = 'startup' | 'first-search' | 'never'

/** Combined session-query configuration backed by SQLite full-text search. */
export interface Config extends SessionQueryConfig {
  /**
   * Dedicated derived-index path; `:memory:` is supported for ephemeral
   * indexes. Missing directories and database files are created owner-only on
   * POSIX filesystems; existing modes are preserved.
   */
  path: string
  /**
   * Open the SQLite module and handle at service activation or the first
   * search, or `never` to disable full-text search: the inherited exact
   * reads, filters, and traces stay available, while `searchSessions` and
   * `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is
   * never imported or opened. Defaults to `startup`.
   */
  openAt?: OpenAt
  /**
   * Prepare the index in the background one delay after a deployment reports
   * its UI is served, so the first search does not pay for the whole initial
   * pass. Omitted: preparation starts with the first search.
   */
  warmupAfterReadyMs?: number
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Page size when a request omits `limit`. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 20. */
  defaultLimit?: number
  /** Largest accepted page size. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 100. */
  maxLimit?: number
  /** Maximum snippet length in Unicode code points. Defaults to 240. */
  snippetChars?: number
  /** Maximum concurrent persisted-log reads in one inherited batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /** Maximum cold prepared-Session observations the inherited reader retains for reuse. Defaults to 5. */
  preparedSessionCacheSize?: number
  /**
   * Stored Sessions one reconciliation decides before it reports progress and
   * yields the event loop, which is what lets a listener observe the pass
   * advance. A larger batch trades that granularity for fewer yields; defaults
   * to 16.
   */
  reconcileBatchSize?: number
}

interface ResolvedConfig {
  path: string
  openAt: OpenAt
  warmupAfterReadyMs?: number
  journalMode: JournalMode
  defaultLimit: number
  maxLimit: number
  snippetChars: number
  readWindowMax: number
  persistedReadConcurrency: number
  preparedSessionCacheSize: number
  reconcileBatchSize: number
}

interface ObservedSession {
  header: SessionHeader
  inheritedEventCount: SessionLogOffset
  documents: SessionEventSearchDocument[]
  fingerprint: string
}

interface ObservedPersistedSession {
  header: SessionHeader
  revision: SessionPersistenceRevision
  loaded?: ObservedSession
  /** Set when this revision's cold read or document extraction threw; the session stays out of the index. */
  unreadable?: { readonly error: unknown }
}

/** A stored revision whose cold read or document extraction threw, with the thrown value. */
interface UnreadableSession {
  readonly revision: SessionPersistenceRevision
  readonly error: unknown
}

interface PersistenceBinding {
  readonly identity: symbol
  readonly service?: SessionPersistence
}

interface Observation {
  persistenceBinding: PersistenceBinding
  persisted: Map<SessionId, ObservedPersistedSession>
  live: Map<SessionId, ObservedSession>
  /** Stored Sessions this pass decided, including the skipped ones. */
  examined: number
  /** Examined stored Sessions whose stored revision matched the index. */
  skipped: number
}

interface IndexedPersistedRow {
  id: string
  revision: string
  generation: number
}

interface IndexedLiveRow {
  id: string
  fingerprint: string
  persisted: number
  generation: number
}

interface SessionHeaderRow {
  session_id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
}

/**
 * Project one reported SQLite row onto the columns the search SQL selects.
 *
 * `StatementSync.all()` reports `Record<string, SQLOutputValue>`, and this
 * index cannot narrow that at the call site: the statements build their column
 * list in generated CTEs. Projecting each field keeps the conversion explicit
 * rather than asserting the whole row across the boundary.
 * @param row - one row reported by a search statement.
 * @returns the same values under the types those statements guarantee.
 */
function toSearchRow(row: Record<string, SQLOutputValue>): SearchRow {
  const optionalText = (value: SQLOutputValue | undefined): string | null =>
    value === null || value === undefined ? null : String(value)
  const optionalNumber = (value: SQLOutputValue | undefined): number | null =>
    value === null || value === undefined ? null : Number(value)
  return {
    session_id: String(row.session_id),
    version: Number(row.version),
    created_at: Number(row.created_at),
    cwd: optionalText(row.cwd),
    parent_session: optionalText(row.parent_session),
    seed_length: optionalNumber(row.seed_length),
    delegation_depth: optionalNumber(row.delegation_depth),
    agent_preset: optionalText(row.agent_preset),
    live: Number(row.live),
    persisted: Number(row.persisted),
    seq: Number(row.seq),
    type: String(row.type),
    time: Number(row.time),
    surface: String(row.surface),
    marked_text: String(row.marked_text),
    match_count: Number(row.match_count),
    document_length: Number(row.document_length),
  }
}

interface SearchRow extends SessionHeaderRow {
  live: number
  persisted: number
  seq: number
  type: string
  time: number
  surface: string
  marked_text: string
  match_count: number
  document_length: number
}

interface CursorPayload {
  version: 1
  instance: string
  scope: 'sessions' | 'events' | 'messages'
  fingerprint: string
  generation: string
  offset: number
}

/** Concrete SQLite owner of the combined `ctx.sessionQuery` service. */
export class SqliteSessionQueryEngine extends SessionQueryEngine {
  static override inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    openAt: z.union(['startup', 'first-search', 'never'] as const).default('startup'),
    warmupAfterReadyMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    defaultLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_DEFAULT_LIMIT),
    maxLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_MAX_LIMIT),
    snippetChars: z.number().step(1).min(1).default(SESSION_QUERY_SQLITE_SNIPPET_CHARS),
    readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
    persistedReadConcurrency: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY),
    preparedSessionCacheSize: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    reconcileBatchSize: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_SQLITE_DEFAULT_RECONCILE_BATCH_SIZE),
  })

  /** Validated and defaulted backend configuration. */
  readonly config: ResolvedConfig

  private readonly _instance = randomUUID()
  private _ready: Promise<void> | undefined
  private _db: DatabaseSync | undefined
  private _persistenceBinding: PersistenceBinding = { identity: Symbol() }
  private _lastPersistenceIdentity: symbol | undefined
  private _persistenceEpoch = 0
  private _globalGeneration = 0
  private _localGeneration = 0
  private _tail: Promise<void> = Promise.resolve()
  private _warmupState: 'idle' | 'scheduled' | 'running' | 'done' = 'idle'
  private _warmupTimer: ReturnType<typeof setTimeout> | undefined
  private _warmupTask: Promise<void> | undefined
  private _closed = false
  private _closePromise: Promise<void> | undefined
  private readonly _optionalPersistenceFiber: Fiber
  /** Stored sessions the last stable observation could not read; drives the once-per-failure warnings. */
  private _unreadable = new Map<SessionId, UnreadableSession>()

  constructor(ctx: Context, config: Config) {
    // The assignment expression resolves before the base constructor can
    // register `ctx.sessionQuery`; keep that same validated value afterward.
    super(ctx, config = resolveConfig(config))
    this.config = config as ResolvedConfig
    this._optionalPersistenceFiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const service = childCtx.sessionPersistence
      const binding = { identity: Symbol(), service }
      this._persistenceBinding = binding
      childCtx.effect(() => () => {
        /* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
        if (this._persistenceBinding !== binding) return
        this._persistenceBinding = { identity: Symbol() }
      }, 'sessionQuerySqlite.persistenceBinding')
    })
    ctx.effect(() => {
      return () => this._optionalPersistenceFiber.dispose()
    }, 'sessionQuerySqlite.optionalPersistence')
    ctx.effect(() => {
      const off = ctx.on('session-query/warmup-requested', () => { this._requestWarmup() })
      return () => {
        off()
        this._cancelWarmup()
      }
    }, 'sessionQuerySqlite.warmup')
    ctx.effect(() => async () => this.close(), 'sessionQuerySqlite.close')
  }

  /**
   * Open eagerly only when activation owns the configured readiness boundary.
   *
   * Activation reports no preparation phase: no search is waiting on this
   * open, and a published `opening` would outlive it in every later baseline.
   */
  protected async [Service.init](): Promise<void> {
    if (this.config.openAt === 'startup') await this._ensureReady(undefined, false)
  }

  override async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    this._assertSearchEnabled()
    const normalized = normalizeSessionRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      const { offset, generation, fingerprint, persistenceBinding } =
        await this._beginCrossSessionPage(normalized, 'sessions', signal)
      const rows = this._querySessions(normalized, offset, persistenceBinding)
      return page(rows, normalized.limit, row => this._sessionHit(row), cursorOffset => encodeCursor({
        version: 1,
        instance: this._instance,
        scope: 'sessions',
        fingerprint,
        generation,
        offset: cursorOffset,
      }), offset)
    })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    this._assertSearchEnabled()
    const normalized = normalizeEventRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const unreadable = this._unreadable.get(normalized.sessionId)
      if (unreadable !== undefined) {
        // A SessionQueryError from the read or extraction, such as SESSION_QUERY_INVALID_SURFACE,
        // keeps its code as in `_observeStable`'s outer catch; any other failure is a persistence failure.
        if (unreadable.error instanceof SessionQueryError) throw unreadable.error
        throw new SessionQueryError(
          `session-search could not read session "${normalized.sessionId}": ${errorMessage(unreadable.error)}`,
          'SESSION_QUERY_PERSISTENCE_FAILED',
          { cause: unreadable.error },
        )
      }
      const target = this._targetObservation(normalized.sessionId, persistenceBinding)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'events', fingerprint, target.generation)
      const rows = this._queryEvents(normalized, offset, persistenceBinding)
      return {
        session: target.header,
        ...page(rows, normalized.limit, row => this._eventHit(row), cursorOffset => encodeCursor({
          version: 1,
          instance: this._instance,
          scope: 'events',
          fingerprint,
          generation: target.generation,
          offset: cursorOffset,
        }), offset),
      }
    })
  }

  override async searchMessages(
    request: SessionMessageSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionEventSearchHit>> {
    this._assertSearchEnabled()
    const normalized = normalizeSessionRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      const { offset, generation, fingerprint, persistenceBinding } =
        await this._beginCrossSessionPage(normalized, 'messages', signal)
      const rows = await this._queryMessages(normalized, offset, persistenceBinding)
      return {
        ...page(rows, normalized.limit, row => this._eventHit(row), cursorOffset => encodeCursor({
          version: 1,
          instance: this._instance,
          scope: 'messages',
          fingerprint,
          generation,
          offset: cursorOffset,
        }), offset),
        coverage: this._coverage(),
      }
    })
  }

  /**
   * Report how much of the observed corpus this indexed generation covers.
   *
   * A Session the read or extraction failed on is skipped rather than failing
   * the whole page, so a caller that only sees items cannot distinguish "no
   * match" from "not looked at". This is the only place that can.
   * @returns complete coverage, or the count that made it partial.
   */
  private _coverage(): SessionSearchCoverage {
    const skipped = this._unreadable.size
    return skipped === 0
      ? { status: 'complete', skippedSessions: 0 }
      : { status: 'partial', skippedSessions: skipped }
  }

  /** Close the database after every accepted operation reaches quiescence. */
  close(): Promise<void> {
    this._closePromise ??= this._close()
    return this._closePromise
  }

  /**
   * Refuse full-text calls under `openAt: 'never'` before any request
   * normalization or SQLite work, so a disabled deployment never imports
   * node:sqlite, opens the index, or observes sources.
   */
  private _assertSearchEnabled(): void {
    if (this.config.openAt !== 'never') return
    throw new SessionQueryError(
      'session search is disabled: this deployment configures the session-query index with openAt "never"',
      'SESSION_QUERY_SEARCH_DISABLED',
    )
  }

  /**
   * Schedule one background preparation after a deployment reports its UI is
   * up. Repeated requests are ignored, and a failed preparation leaves the
   * next search to prepare again rather than retrying in the background.
   */
  private _requestWarmup(): void {
    const delay = this.config.warmupAfterReadyMs
    if (delay === undefined || this._warmupState !== 'idle' || this._isClosed()) return
    this._warmupState = 'scheduled'
    const timer = setTimeout(() => {
      this._warmupTimer = undefined
      if (this._isClosed()) {
        this._warmupState = 'idle'
        return
      }
      this._warmupState = 'running'
      this._warmupTask = this._prepareWarmup()
    }, delay)
    timer.unref?.()
    this._warmupTimer = timer
  }

  /** Prepare the index on the same queue searches use, reporting its failure once. */
  private async _prepareWarmup(): Promise<void> {
    try {
      await this._serialized(undefined, async () => {
        if (this._isClosed()) return
        await this._ensureReady(undefined, false)
        await this._reconcile(undefined)
      })
    } catch (error: unknown) {
      // The background attempt stops here: the next search prepares again and
      // reports a real storage failure itself.
      if (!this._isClosed()) {
        this.ctx.logger.warn(`session-search index warmup did not finish: ${errorMessage(error)}`)
      }
    } finally {
      this._warmupState = 'done'
      this._warmupTask = undefined
    }
  }

  /** Release the pending warmup timer; a running preparation finishes with the queue. */
  private _cancelWarmup(): void {
    if (this._warmupTimer === undefined) return
    clearTimeout(this._warmupTimer)
    this._warmupTimer = undefined
    if (this._warmupState === 'scheduled') this._warmupState = 'idle'
  }

  private async _close(): Promise<void> {
    this._closed = true
    this._cancelWarmup()
    await this._tail
    await this._warmupTask
    if (this._ready !== undefined) {
      try {
        await this._ready
      } catch {
        // Opening already closed a partially-created handle; disposal only waits.
      }
    }
    this._db?.close()
    this._db = undefined
  }

  private async _open(): Promise<void> {
    const db = await openSearchDatabase(this.config.path, this.config.journalMode)
    try {
      const state = db.prepare(
        'SELECT global_generation FROM search_state WHERE singleton = 1',
      ).get() as { global_generation: number }
      this._globalGeneration = state.global_generation
      this._localGeneration = state.global_generation
      this._db = db
    } catch (error: unknown) {
      db.close()
      throw error
    }
  }

  /**
   * Open the index once and wait for that open.
   * @param signal - cancellation for the wait.
   * @param reportOpening - whether a waiting search observes the opening phase;
   *   activation opens with no search to report to.
   */
  private async _ensureReady(signal: AbortSignal | undefined, reportOpening = true): Promise<void> {
    if (this._ready === undefined) {
      if (reportOpening) {
        this._reportSearchIndexProgress({ phase: 'opening', examined: 0, total: 0, skipped: 0 })
      }
      const opening = this._open()
      this._ready = opening
      // A failed open must not stay cached: the next request opens again and
      // reports its own failure instead of awaiting a settled rejection.
      void opening.catch(() => {
        if (this._ready === opening) this._ready = undefined
      })
    }
    try {
      await waitWithAbort(this._ready, signal)
    } catch (error: unknown) {
      if (isAbort(error)) throw error
      throw new SessionQueryError(
        `session-search SQLite index failed to open: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  private async _serialized<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (this._isClosed()) throw indexClosed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const prior = this._tail
    this._tail = prior.then(() => gate)
    try {
      await waitWithAbort(prior, signal)
    } catch (error: unknown) {
      release()
      throw error
    }
    if (this._isClosed()) {
      release()
      throw indexClosed()
    }
    try {
      assertNotAborted(signal)
      return await operation()
    } finally {
      release()
    }
  }

  private async _reconcile(signal: AbortSignal | undefined): Promise<PersistenceBinding> {
    assertNotAborted(signal)
    const db = this._requireDb()
    const persistedRows = db.prepare(
      'SELECT id, revision, generation FROM persisted_sessions',
    ).all() as unknown as IndexedPersistedRow[]
    const liveRows = db.prepare(
      'SELECT id, fingerprint, persisted, generation FROM temp.live_sessions',
    ).all() as unknown as IndexedLiveRow[]
    const persistedById = new Map(persistedRows.map(row => [row.id as SessionId, row]))
    const liveById = new Map(liveRows.map(row => [row.id as SessionId, row]))
    const observation = await this._observeStable(persistedById, signal)
    assertNotAborted(signal)
    const persistentChanges = observation.persistenceBinding.service === undefined
      ? []
      : [...observation.persisted.values()].filter(entry => entry.loaded !== undefined)
    const unreadable = new Map<SessionId, UnreadableSession>()
    for (const entry of observation.persisted.values()) {
      if (entry.unreadable !== undefined) {
        unreadable.set(entry.header.id, { revision: entry.revision, error: entry.unreadable.error })
      }
    }
    // A row indexed from an earlier revision of an unreadable log is removed, so hits only
    // come from revisions this index could read.
    const persistentDeletes = observation.persistenceBinding.service === undefined
      ? []
      : persistedRows.filter(row => unreadable.has(row.id as SessionId) || !observation.persisted.has(row.id as SessionId))
    const liveChanges = [...observation.live.values()].filter((entry) => {
      const indexed = liveById.get(entry.header.id)
      const persisted = observation.persisted.has(entry.header.id) ? 1 : 0
      return indexed?.fingerprint !== entry.fingerprint || indexed.persisted !== persisted
    })
    const liveDeletes = liveRows.filter(row => !observation.live.has(row.id as SessionId))
    const pointerChanged = this._lastPersistenceIdentity !== undefined
      && this._lastPersistenceIdentity !== observation.persistenceBinding.identity
    const hasWrites = persistentChanges.length > 0
      || persistentDeletes.length > 0
      || liveChanges.length > 0
      || liveDeletes.length > 0

    let nextMainGeneration = this._mainGeneration()
    let nextLocalGeneration = this._localGeneration
    if (persistentChanges.length > 0 || persistentDeletes.length > 0) nextMainGeneration += 1
    const liveReplacements = liveChanges.map((entry) => {
      nextLocalGeneration = Math.max(nextLocalGeneration, nextMainGeneration) + 1
      return {
        entry,
        generation: nextLocalGeneration,
        persisted: observation.persisted.has(entry.header.id),
      }
    })

    if (hasWrites) {
      let began = false
      try {
        db.exec('BEGIN IMMEDIATE')
        began = true
        for (const row of persistentDeletes) this._deleteSession('persisted', row.id as SessionId)
        for (const entry of persistentChanges) {
          /* v8 ignore next -- observation loads every entry whose revision differs */
          if (entry.loaded === undefined) throw new Error(`missing loaded revision for session "${entry.header.id}"`)
          this._replacePersistedSession(entry.loaded, entry.revision, nextMainGeneration)
        }
        if (persistentChanges.length > 0 || persistentDeletes.length > 0) {
          db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(nextMainGeneration)
        }
        for (const row of liveDeletes) this._deleteSession('live', row.id as SessionId)
        for (const { entry, generation, persisted } of liveReplacements) {
          this._replaceLiveSession(entry, generation, persisted)
        }
        db.exec('COMMIT')
      } catch (error: unknown) {
        /* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
        if (began) {
          /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
          try {
            db.exec('ROLLBACK')
          } catch {
            // The original SQLite failure remains the actionable cause.
          }
        }
        throw new SessionQueryError(
          `session-search reconciliation failed: ${errorMessage(error)}`,
          'SESSION_QUERY_INDEX_FAILED',
          { cause: error },
        )
      }
    }

    if (hasWrites || pointerChanged) this._globalGeneration += 1
    if (pointerChanged) this._persistenceEpoch += 1
    this._localGeneration = nextLocalGeneration
    this._lastPersistenceIdentity = observation.persistenceBinding.identity
    this._recordUnreadable(unreadable)
    this._reportSearchIndexProgress({
      phase: 'ready',
      examined: observation.examined,
      total: observation.persisted.size,
      skipped: observation.skipped,
    })
    return observation.persistenceBinding
  }

  /**
   * Replace the unreadable set with this observation's and warn for each session
   * that was readable in the previous observation or now fails with a different
   * message. A session that stays unreadable with the same error warns once, even
   * when its revision changes: older-generation revisions carry a suffix that
   * moves with any write to the store.
   * @param unreadable - persisted sessions whose cold read or extraction threw, by id.
   */
  private _recordUnreadable(unreadable: Map<SessionId, UnreadableSession>): void {
    const previous = this._unreadable
    this._unreadable = unreadable
    for (const [id, { revision, error }] of unreadable) {
      const prior = previous.get(id)
      if (prior !== undefined && errorMessage(prior.error) === errorMessage(error)) continue
      this.ctx.logger.warn(
        `session-search: left session "${id}" (revision ${revision}) out of the index; `
        + `its stored log could not be read: ${errorMessage(error)}`,
      )
    }
  }

  private async _observeStable(
    indexed: ReadonlyMap<SessionId, IndexedPersistedRow>,
    signal: AbortSignal | undefined,
  ): Promise<Observation> {
    for (let attempt = 0; attempt < STABLE_OBSERVATION_ATTEMPTS; attempt += 1) {
      assertNotAborted(signal)
      const persistenceBinding = this._persistenceBinding
      const persistence = persistenceBinding.service
      const initiallyLive = new Set(this.ctx.sessions.list().map(session => session.id))
      let persisted = new Map<SessionId, ObservedPersistedSession>()
      let examined = 0
      let skipped = 0
      if (persistence !== undefined) {
        try {
          const canReuseIndexed = this._lastPersistenceIdentity === undefined
            || this._lastPersistenceIdentity === persistenceBinding.identity
          const listOptions = signal === undefined ? undefined : { signal }
          const before = await persistence.list(listOptions)
          assertNotAborted(signal)
          persisted = materializePersistenceSnapshots(before)
          const total = persisted.size
          // One frame per distinct examined count: a batch boundary and the
          // tail both fall here when the corpus ends on one.
          let reported = -1
          const reportProgress = (): void => {
            if (examined === reported) return
            reported = examined
            this._reportSearchIndexProgress({ phase: 'reconciling', examined, total, skipped })
          }
          reportProgress()
          for (const entry of persisted.values()) {
            if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) {
              skipped += 1
            } else if (!initiallyLive.has(entry.header.id) && this.ctx.sessions.get(entry.header.id) === undefined) {
              // Skip work already shadowed by a live owner. The cold read is
              // non-mutating (interrupted turns are balanced in memory only), so
              // an owner attaching after this check cannot cause side effects;
              // the live-membership retry below makes the returned observation
              // live-preferred.
              await this._observePersistedEntry(persistence, entry, signal)
            }
            examined += 1
            if (examined % this.config.reconcileBatchSize === 0) {
              reportProgress()
              await scheduler.yield()
            }
          }
          reportProgress()
          assertNotAborted(signal)
          const afterSnapshots = await persistence.list(listOptions)
          assertNotAborted(signal)
          const after = materializePersistenceSnapshots(afterSnapshots)
          if (!samePersistenceSnapshots(persisted, after)) continue
          if (this._persistenceBinding !== persistenceBinding) continue
        } catch (error: unknown) {
          if (isAbort(error) || signal?.aborted) {
            throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED', {
              cause: error,
            })
          }
          if (this._persistenceBinding !== persistenceBinding) continue
          if (error instanceof SessionQueryError) throw error
          throw new SessionQueryError(
            `session-search persistence observation failed: ${errorMessage(error)}`,
            'SESSION_QUERY_PERSISTENCE_FAILED',
            { cause: error },
          )
        }
      }
      const live = new Map<SessionId, ObservedSession>()
      for (const session of this.ctx.sessions.list()) {
        const observed = observeLive(session)
        const durable = persisted.get(session.id)
        if (durable !== undefined) assertSessionHeadersCompatible(observed.header, durable.header)
        live.set(session.id, observed)
      }
      if (!sameSessionIds(initiallyLive, live)) continue
      return { persistenceBinding, persisted, live, examined, skipped }
    }
    throw new SessionQueryError(
      'session-search persistence observation did not stabilize after one retry',
      'SESSION_QUERY_PERSISTENCE_FAILED',
    )
  }

  /**
   * Load one listed stored Session in place.
   *
   * A log that cannot be read or extracted is confined to its own revision and
   * stays out of the index; a listed header that disagrees with the stored one
   * is not, and reaches the caller's stability attempt as
   * `SESSION_QUERY_SOURCE_CONFLICT`.
   * @param persistence - bound persistence backend this pass listed from.
   * @param entry - listed revision to read; receives `loaded` or `unreadable`.
   * @param signal - cancellation for the cold read.
   */
  private async _observePersistedEntry(
    persistence: SessionPersistence,
    entry: ObservedPersistedSession,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    assertNotAborted(signal)
    let loaded: ColdSessionLog
    try {
      loaded = await readColdSessionLog(persistence, entry.header.id, signal)
    } catch (error: unknown) {
      // Cancellation keeps the caller's abort mapping; any other failure belongs
      // to this one log, which is left out of the index while the remaining
      // sessions stay searchable.
      if (signal?.aborted) throw error
      entry.unreadable = { error }
      return
    }
    assertNotAborted(signal)
    assertSessionHeadersCompatible(entry.header, loaded.header)
    try {
      entry.loaded = observeSession(loaded.header, loaded.inheritedEventCount, loaded.events)
    } catch (error: unknown) {
      entry.unreadable = { error }
    }
  }

  private _mainGeneration(): number {
    const row = this._requireDb().prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    return row.global_generation
  }

  private _deleteSession(source: 'persisted' | 'live', id: SessionId): void {
    const db = this._requireDb()
    if (source === 'persisted') {
      db.prepare('DELETE FROM persisted_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM persisted_sessions WHERE id = ?').run(id)
    } else {
      db.prepare('DELETE FROM temp.live_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM temp.live_sessions WHERE id = ?').run(id)
    }
  }

  private _replacePersistedSession(
    entry: ObservedSession,
    revision: SessionPersistenceRevision,
    generation: number,
  ): void {
    this._deleteSession('persisted', entry.header.id)
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO persisted_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      revision,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      insert.run(
        text,
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
    }
  }

  private _replaceLiveSession(entry: ObservedSession, generation: number, persisted: boolean): void {
    this._deleteSession('live', entry.header.id)
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO temp.live_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      entry.fingerprint,
      persisted ? 1 : 0,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO temp.live_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      insert.run(
        text,
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
    }
  }

  /**
   * Prepare one cross-session page: wait for the index, reconcile sources, and
   * resolve the cursor offset inside this indexed generation.
   * @param normalized - request already normalized against this backend's limits.
   * @param scope - cursor scope this call pages within.
   * @param signal - caller cancellation.
   * @returns offset, generation, request fingerprint, and the binding being read.
   */
  private async _beginCrossSessionPage(
    normalized: NormalizedSessionRequest,
    scope: 'sessions' | 'messages',
    signal: AbortSignal | undefined,
  ): Promise<{
    offset: number
    generation: string
    fingerprint: string
    persistenceBinding: PersistenceBinding
  }> {
    await this._ensureReady(signal)
    const persistenceBinding = await this._reconcile(signal)
    assertNotAborted(signal)
    const generation = String(this._globalGeneration)
    const fingerprint = requestFingerprint(normalized)
    const offset = normalized.cursor === undefined
      ? 0
      : decodeCursor(normalized.cursor, this._instance, scope, fingerprint, generation)
    return { offset, generation, fingerprint, persistenceBinding }
  }

  private _querySessions(
    request: NormalizedSessionRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
  ): SearchRow[] {
    const { sql, where, bindings } = crossSessionQuery(request, offset, persistenceBinding)
    return this._requireDb().prepare(`
      ${sql},
      filtered AS (
        SELECT * FROM matched ${where.length === 0 ? '' : `WHERE ${where}`}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
        ) AS event_rank
        FROM filtered
      )
      SELECT * FROM ranked
      WHERE event_rank = 1
      ORDER BY match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings).map(toSearchRow)
  }

  /**
   * Select matching events across sessions, keeping every hit.
   *
   * `_querySessions` collapses each session to its strongest event; this reads
   * the ranked rows before that collapse so a page can address individual
   * messages. `session_id` joins the ORDER BY tiebreakers because rows from
   * different sessions can otherwise share every preceding key.
   * @param request - normalized query, session filters, event filters, and limit.
   * @param offset - page offset already validated against the cursor.
   * @param persistenceBinding - binding for the indexed generation being read.
   * @returns one row per matching event, plus the row that proves a next page.
   */
  /**
   * Select matching events across sessions, keeping every hit.
   *
   * Message search matches literal substrings, so it cannot delegate the
   * predicate to FTS5: a token boundary is not a substring boundary, and text
   * like `测clinet` would be reachable only as a whole token. The candidates
   * are therefore the same derived documents with their text intact, and the
   * scan applies the same matcher that later marks the excerpt, so what a
   * reader sees highlighted is exactly what matched. The scan yields every
   * {@link MESSAGE_SCAN_YIELD_ROWS} rows because a deployment's corpus can take
   * a second, and a held event loop would stall unrelated streams.
   * @param request - normalized query, session filters, event filters, and limit.
   * @param offset - page offset already validated against the cursor.
   * @param persistenceBinding - binding for the indexed generation being read.
   * @returns one row per matching event, plus the row that proves a next page.
   */
  private async _queryMessages(
    request: NormalizedSessionRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
  ): Promise<SearchRow[]> {
    const terms = compileMessageTerms(request.query)
    const sessionWhere = buildSessionWhere(request.sessionFilters)
    const eventWhere = buildEventWhere(request.eventFilters)
    assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
    const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
    const visible = persistenceBinding.service !== undefined ? 1 : 0
    const patterns = terms.map(term => `%${escapeLikeTerm(term)}%`)
    const bindings = [
      visible,
      ...patterns,
      visible,
      ...patterns,
      ...sessionWhere.params,
      ...eventWhere.params,
    ]
    assertPortableBindingCount(bindings.length)
    const statement = this._requireDb().prepare(`
      ${selectedMessageScanSql(terms.length).sql}
      SELECT * FROM candidates
      ${where === '' ? '' : `WHERE ${where}`}
    `)
    const hits: SearchRow[] = []
    const rows = statement.iterate(...bindings) as IterableIterator<ScanRow>
    let examined = 0
    for (;;) {
      const next = rows.next()
      if (next.done === true) break
      const marked = markMessageMatches(next.value.document_text, terms)
      if (marked !== undefined) hits.push(scanRow(next.value, marked.marked, marked.count))
      examined += 1
      if (examined % MESSAGE_SCAN_YIELD_ROWS === 0) await scheduler.yield()
    }
    // Every hit is ranked before the page is cut: a page can only be addressed
    // by offset when the whole matching set is ordered the same way each time.
    hits.sort((left, right) =>
      right.match_count - left.match_count
      || left.document_length - right.document_length
      || right.time - left.time
      || (left.session_id < right.session_id ? -1 : left.session_id > right.session_id ? 1 : 0)
      || right.seq - left.seq)
    return hits.slice(offset, offset + request.limit + 1)
  }

  private _queryEvents(
    request: NormalizedEventRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
  ): SearchRow[] {
    const selected = selectedDocumentsSql()
    const eventWhere = buildEventWhere(request.filters)
    assertFts5OuterPredicateCount(1 + eventWhere.predicateCount)
    const where = ['session_id = ?', eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selectedDocumentsParams(request.query, persistenceBinding.service !== undefined),
      request.sessionId,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql}
      SELECT * FROM matched
      WHERE ${where}
      ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings).map(toSearchRow)
  }

  private _targetObservation(
    sessionId: SessionId,
    persistenceBinding: PersistenceBinding,
  ): { header: SessionHeader; generation: string } {
    const db = this._requireDb()
    const live = db.prepare(
      `SELECT
        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
      FROM temp.live_sessions
      WHERE id = ?`,
    ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
    if (live !== undefined) {
      return { header: rowHeader(live), generation: `live:${live.generation}` }
    }
    if (persistenceBinding.service !== undefined) {
      const persisted = db.prepare(
        `SELECT
          id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
        FROM persisted_sessions
        WHERE id = ?`,
      ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
      if (persisted !== undefined) {
        return {
          header: rowHeader(persisted),
          generation: `persisted:${this._persistenceEpoch}:${persisted.generation}`,
        }
      }
    }
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  private _sessionHit(row: SearchRow): SessionSearchHit {
    return {
      header: rowHeader(row),
      live: row.live === 1,
      persisted: row.persisted === 1,
      bestMatch: this._eventHit(row),
    }
  }

  private _eventHit(row: SearchRow): SessionEventSearchHit {
    const { snippet, matches } = makeSnippet(row.marked_text, this.config.snippetChars)
    return {
      sessionId: row.session_id as SessionId,
      seq: SessionSeq(row.seq),
      type: row.type as SessionEventSearchHit['type'],
      time: row.time,
      surface: row.surface as SessionEventSearchHit['surface'],
      snippet,
      matches,
    }
  }

  private _requireDb(): DatabaseSync {
    /* v8 ignore next -- callers await `_ready`; this guards lifecycle misuse */
    if (this._db === undefined) throw indexClosed()
    return this._db
  }

  private _isClosed(): boolean {
    return this._closed
  }
}

/**
 * The header columns both session upserts bind, in the order their INSERT
 * lists them. The two statements differ only in what they append after these.
 * @param header - the session header being written.
 * @returns one bound value per header column.
 */
function headerBindings(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): (string | number | null)[] {
  return [
    header.id,
    header.version,
    header.createdAt,
    header.cwd ?? null,
    header.parentSession ?? null,
    header.isSeeded ? inheritedEventCount : null,
    header.delegationDepth ?? null,
    header.agentPreset ?? null,
  ]
}

function selectedDocumentsSql(): { sql: string } {
  return {
    sql: `WITH candidates AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        ps.delegation_depth AS delegation_depth,
        ps.agent_preset AS agent_preset,
        0 AS live,
        1 AS persisted,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        highlight(persisted_docs, 0, ?, ?) AS marked_text,
        CAST(pd.codepoint_length AS INTEGER) AS document_length
      FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      WHERE persisted_docs MATCH ?
        AND ? = 1
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        ls.delegation_depth AS delegation_depth,
        ls.agent_preset AS agent_preset,
        1 AS live,
        CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        highlight(live_docs, 0, ?, ?) AS marked_text,
        CAST(ld.codepoint_length AS INTEGER) AS document_length
      FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
      WHERE live_docs MATCH ?
    ), matched AS (
      SELECT *,
        (
          length(CAST(marked_text AS BLOB))
          - length(CAST(replace(marked_text, ?, '') AS BLOB))
        ) / ? AS match_count
      FROM candidates
    )`,
  }
}

/**
 * Build the candidate rows a literal message search scans.
 *
 * Same sources, metadata and live-overrides-persisted rule as
 * {@link selectedDocumentsSql}, with the document text itself instead of an
 * FTS5-marked excerpt: the scan marks matches after it has proved every term
 * is present, so the marks describe the text a reader is looking at.
 * @returns the candidate CTE; its bindings are two visibility flags.
 */
function selectedMessageScanSql(termCount: number): { sql: string } {
  const kinds = MESSAGE_SEARCH_TYPES.map(kind => `'${kind}'`).join(', ')
  const literal = Array.from({ length: termCount }, () => 'AND pd.text LIKE ? ESCAPE \'\\\'').join('\n        ')
  const literalLive = Array.from({ length: termCount }, () => 'AND ld.text LIKE ? ESCAPE \'\\\'').join('\n        ')
  return {
    sql: `WITH candidates AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        ps.delegation_depth AS delegation_depth,
        ps.agent_preset AS agent_preset,
        0 AS live,
        1 AS persisted,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        pd.text AS document_text,
        CAST(pd.codepoint_length AS INTEGER) AS document_length
      FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      WHERE ? = 1
        AND pd.type IN (${kinds})
        ${literal}
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        ls.delegation_depth AS delegation_depth,
        ls.agent_preset AS agent_preset,
        1 AS live,
        CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        ld.text AS document_text,
        CAST(ld.codepoint_length AS INTEGER) AS document_length
      FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
      WHERE 1 = 1
        AND ld.type IN (${kinds})
        ${literalLive}
    )`,
  }
}

/** Event kinds a message search returns: prose a reader can be shown. */
const MESSAGE_SEARCH_TYPES = ['user/message', 'assistant/message'] as const

/** Rows one message scan examines before it lets the event loop run. */
const MESSAGE_SCAN_YIELD_ROWS = 256

/** One candidate row of {@link selectedMessageScanSql} before matching. */
interface ScanRow {
  session_id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
  live: number
  persisted: number
  seq: number
  type: string
  time: number
  surface: string
  document_text: string
  document_length: number
}

/**
 * Turn one scanned candidate into the row shape the page builder reads.
 * @param row - candidate whose every term was found.
 * @param marked - its text with match markers.
 * @param matchCount - merged match count over the whole document.
 * @returns search row carrying the marked text.
 */
function scanRow(row: ScanRow, marked: string, matchCount: number): SearchRow {
  return {
    session_id: row.session_id,
    version: row.version,
    created_at: row.created_at,
    cwd: row.cwd,
    parent_session: row.parent_session,
    seed_length: row.seed_length,
    delegation_depth: row.delegation_depth,
    agent_preset: row.agent_preset,
    live: row.live,
    persisted: row.persisted,
    seq: row.seq,
    type: row.type,
    time: row.time,
    surface: row.surface,
    marked_text: marked,
    match_count: matchCount,
    document_length: row.document_length,
  }
}

/**
 * Build the SQL that both cross-session reads share.
 *
 * `_querySessions` and `_queryMessages` differ only in what they select from
 * `matched`; the CTE, the predicate compilation, and the binding order are the
 * same, and every safety assertion runs here before either statement prepares.
 * @param request - normalized cross-session request.
 * @param offset - page offset already validated against the cursor.
 * @param persistenceBinding - binding for the indexed generation being read.
 * @returns the CTE text, the combined predicate, and its ordered bindings.
 */
function crossSessionQuery(
  request: NormalizedSessionRequest,
  offset: number,
  persistenceBinding: PersistenceBinding,
): { sql: string; where: string; bindings: Array<string | number> } {
  const selected = selectedDocumentsSql()
  const sessionWhere = buildSessionWhere(request.sessionFilters)
  const eventWhere = buildEventWhere(request.eventFilters)
  assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
  const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
  const bindings = [
    ...selectedDocumentsParams(request.query, persistenceBinding.service !== undefined),
    ...sessionWhere.params,
    ...eventWhere.params,
    request.limit + 1,
    offset,
  ]
  assertPortableBindingCount(bindings.length)
  return { sql: selected.sql, where, bindings }
}

function selectedDocumentsParams(query: string, persistenceVisible: boolean): Array<string | number> {
  const expression = quoteFtsData(query)
  const visible = persistenceVisible ? 1 : 0
  return [
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    visible,
    visible,
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    FTS_HIGHLIGHT_START,
    Buffer.byteLength(FTS_HIGHLIGHT_START, 'utf8'),
  ]
}

function observeLive(session: Session): ObservedSession {
  return observeSession(session.header, session.inheritedEventCount, session.snapshotEvents())
}

function observeSession(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
  events: readonly SessionEvent[],
): ObservedSession {
  const detachedHeader = structuredClone(header)
  const detachedEvents = events.map(event => structuredClone(event))
  return {
    header: detachedHeader,
    inheritedEventCount,
    documents: buildSessionEventSearchDocuments(detachedHeader.id, detachedEvents),
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ header: detachedHeader, inheritedEventCount, events: detachedEvents }))
      .digest('base64url'),
  }
}

function materializePersistenceSnapshots(
  snapshots: readonly SessionPersistenceSnapshot[],
): Map<SessionId, ObservedPersistedSession> {
  if (!isRuntimeArray(snapshots)) throw new Error('persistence snapshots must be an array')
  const result = new Map<SessionId, ObservedPersistedSession>()
  for (const snapshot of snapshots) {
    if (typeof snapshot.revision !== 'string') {
      throw new Error('persistence snapshot revision must be a string')
    }
    const header = structuredClone(snapshot.header)
    if (result.has(header.id)) {
      throw new Error(`persistence listed duplicate session "${header.id}"`)
    }
    result.set(header.id, { header, revision: snapshot.revision })
  }
  return result
}

function samePersistenceSnapshots(
  before: ReadonlyMap<SessionId, ObservedPersistedSession>,
  after: ReadonlyMap<SessionId, ObservedPersistedSession>,
): boolean {
  if (before.size !== after.size) return false
  for (const [id, first] of before) {
    const second = after.get(id)
    if (
      second === undefined
      || first.revision !== second.revision
      || !sameHeader(first.header, second.header)
    ) return false
  }
  return true
}

function sameSessionIds(
  before: ReadonlySet<SessionId>,
  after: ReadonlyMap<SessionId, ObservedSession>,
): boolean {
  if (before.size !== after.size) return false
  for (const id of before) {
    if (!after.has(id)) return false
  }
  return true
}

function sameHeader(a: SessionHeader, b: SessionHeader): boolean {
  return a.id === b.id
    && a.createdAt === b.createdAt
    && a.cwd === b.cwd
    && a.parentSession === b.parentSession
    && a.isSeeded === b.isSeeded
    && (a.delegationDepth ?? 0) === (b.delegationDepth ?? 0)
    && a.agentPreset === b.agentPreset
}

function rowHeader(row: SessionHeaderRow): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: row.session_id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    isSeeded: row.seed_length !== null,
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

function page<Row, Item>(
  rows: readonly Row[],
  limit: number,
  convert: (row: Row) => Item,
  nextCursor: (offset: number) => SessionSearchCursorValue,
  offset: number,
): SessionSearchPage<Item> {
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit).map(convert),
    ...hasMore ? { nextCursor: nextCursor(offset + limit) } : {},
  }
}

function encodeCursor(payload: CursorPayload): SessionSearchCursorValue {
  return SessionSearchCursor(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'))
}

function decodeCursor(
  cursor: SessionSearchCursorValue,
  instance: string,
  scope: CursorPayload['scope'],
  fingerprint: string,
  generation: string,
): number {
  let decoded: Partial<CursorPayload>
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload> | null
    // A well-formed JSON document need not be an object: `null`, a string, or a
    // number would reach the field checks below and fail as a TypeError instead
    // of the typed cursor error a caller can act on.
    if (parsed === null || typeof parsed !== 'object') throw new Error('cursor is not an object')
    decoded = parsed
  } catch (error: unknown) {
    throw invalidCursor(error)
  }
  if (
    decoded.version !== 1
    || decoded.instance !== instance
    || decoded.scope !== scope
    || decoded.fingerprint !== fingerprint
    || !Number.isSafeInteger(decoded.offset)
    || decoded.offset === undefined
    || decoded.offset < 0
  ) {
    throw invalidCursor(new Error('cursor does not belong to this normalized request'))
  }
  if (decoded.generation !== generation) {
    throw new SessionQueryError(
      'session-search cursor is stale because its relevant corpus changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
  }
  return decoded.offset
}

function invalidCursor(cause: unknown): SessionQueryError {
  return new SessionQueryError(
    'session-search cursor is invalid',
    'SESSION_QUERY_INVALID_CURSOR',
    { cause },
  )
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    path: config.path,
    openAt: config.openAt ?? 'startup',
    journalMode: config.journalMode ?? 'wal',
    defaultLimit: config.defaultLimit ?? SESSION_QUERY_SQLITE_DEFAULT_LIMIT,
    maxLimit: config.maxLimit ?? SESSION_QUERY_SQLITE_MAX_LIMIT,
    snippetChars: config.snippetChars ?? SESSION_QUERY_SQLITE_SNIPPET_CHARS,
    readWindowMax: config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX,
    persistedReadConcurrency: config.persistedReadConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
    preparedSessionCacheSize: config.preparedSessionCacheSize
      ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
    reconcileBatchSize: config.reconcileBatchSize
      ?? SESSION_QUERY_SQLITE_DEFAULT_RECONCILE_BATCH_SIZE,
  }
  if (typeof resolved.path !== 'string' || resolved.path.trim().length === 0) {
    throw invalidConfig('path must not be blank')
  }
  const openPhases: readonly string[] = ['startup', 'first-search', 'never']
  if (!openPhases.includes(resolved.openAt)) throw invalidConfig('openAt is not supported')
  const warmupAfterReadyMs = config.warmupAfterReadyMs
  if (warmupAfterReadyMs !== undefined) {
    if (
      !Number.isSafeInteger(warmupAfterReadyMs)
      || warmupAfterReadyMs < 0
      || warmupAfterReadyMs > MAX_TIMER_DELAY_MS
    ) {
      throw invalidConfig(`warmupAfterReadyMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`)
    }
    if (resolved.openAt === 'never') {
      throw invalidConfig('warmupAfterReadyMs requires full-text search, which openAt "never" disables')
    }
    resolved.warmupAfterReadyMs = warmupAfterReadyMs
  }
  assertPageLimit('defaultLimit', resolved.defaultLimit)
  assertPageLimit('maxLimit', resolved.maxLimit)
  assertPositiveInteger('snippetChars', resolved.snippetChars)
  if (!Number.isInteger(resolved.readWindowMax) || resolved.readWindowMax < 0) {
    throw invalidConfig('readWindowMax must be a non-negative integer')
  }
  if (
    !Number.isSafeInteger(resolved.persistedReadConcurrency)
    || resolved.persistedReadConcurrency < 1
  ) {
    throw invalidConfig('persistedReadConcurrency must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(resolved.preparedSessionCacheSize)
    || resolved.preparedSessionCacheSize < 1
  ) {
    throw invalidConfig('preparedSessionCacheSize must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(resolved.reconcileBatchSize)
    || resolved.reconcileBatchSize < 1
  ) {
    throw invalidConfig('reconcileBatchSize must be a positive safe integer')
  }
  if (resolved.defaultLimit > resolved.maxLimit) {
    throw invalidConfig('defaultLimit must be less than or equal to maxLimit')
  }
  const journalModes: readonly string[] = ['wal', 'delete', 'truncate', 'persist']
  if (!journalModes.includes(resolved.journalMode)) throw invalidConfig('journalMode is not supported')
  return resolved
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw invalidConfig(`${name} must be a positive integer`)
}

function assertPageLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_MAX_PAGE_LIMIT) {
    throw invalidConfig(`${name} must be an integer between 1 and ${SQLITE_MAX_PAGE_LIMIT}`)
  }
}

function invalidConfig(detail: string): SessionQueryError {
  return new SessionQueryError(
    `session-search SQLite config: ${detail}`,
    'SESSION_QUERY_INVALID_CONFIG',
  )
}

function indexClosed(): SessionQueryError {
  return new SessionQueryError('session-search SQLite index is closed', 'SESSION_QUERY_INDEX_FAILED')
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED')
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(error))
      },
    )
  })
}

function isAbort(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('session-search dependency rejected with a non-Error value', { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value)
}

export default SqliteSessionQueryEngine
