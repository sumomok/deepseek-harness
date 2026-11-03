# Session Query

English | [中文](session-query.zh.md)

Query vocabulary over the live-preferred logical session corpus. The [Service Definition package](../../packages/session-query/session-query) owns exact reads, source precedence, relationship tracing, semantic extraction, and provider-independent filters, while the [SQLite provider](../../packages/session-query/session-query-sqlite) owns the concrete full-text index lifecycle.

Source: [`packages/session-query/session-query/src/types.ts`](../../packages/session-query/session-query/src/types.ts)

## Logical records

`SessionRecord` is returned by the cross-corpus list. It exposes source availability independently from the cloned live-preferred header. `SessionEventRecord` is a lightweight raw-log projection; classification uses the same `foldSurface()` transitions as model-history derivation.

```ts type-equiv
/** Whether an event is current model context, replaced context, or raw-log-only. */
type SessionEventSurface = 'current' | 'shadowed' | 'log-only'
```

```ts type-equiv
/** Lightweight identity and source availability for one logical session. */
interface SessionRecord {
  /** Cloned session header selected from the live-preferred corpus. */
  header: SessionHeader
  /** Whether the id currently exists in `ctx.sessions`. */
  live: boolean
  /** Whether the active persistence backend currently lists the id, including a created-but-unmaterialized session it already observes. */
  persisted: boolean
  /** Current for live Sessions; otherwise the persistence format status when reported. */
  formatStatus?: 'current' | 'migration-required'
}
```

`SessionLogSnapshot` is the complete detached, replay-validated raw log used by resume preflight. `SessionSurfaceSnapshot` is one exact-read surface observation rather than a retained subscription.

```ts type-equiv
/** One validated detached observation of a logical session's complete raw log. */
interface SessionLogSnapshot {
  /** Cloned session header selected from the same observation as `events`. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Cloned contiguous raw events after in-memory interrupted-turn balancing and replay validation. */
  events: SessionEvent[]
}
```

```ts type-equiv
/** One atomic live-preferred observation of a session's current model surface. */
interface SessionSurfaceSnapshot {
  /** Cloned session header selected from the same corpus observation as `events`. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Highest raw-log seq included in the observation, or `null` for an empty log. */
  capturedThroughSeq: OptionalSessionSeq
  /** Cloned current surface events in model-history order. */
  events: SurfaceEvent[]
}
```

`SessionTitleObservation` applies the same atomic-observation rule to title folding, so an authorization consumer can validate the source header that supplied the title. Batch reads return one ordered `SessionTitleObservationResult` per unique requested id: operational failures remain local to that id, while cancellation rejects the complete operation.

```ts type-equiv
/** Latest folded title bound to the same session-header observation. */
interface SessionTitleObservation {
  /** Cloned header selected with the event log used for the title fold. */
  session: SessionHeader
  /** Latest title snapshot, absent when the observed log has no title. */
  title?: SessionTitleSnapshot
}
```

```ts type-equiv
/** One ordered result from a batch title observation. */
type SessionTitleObservationResult =
  | {
    /** Requested session id. */
    sessionId: SessionId
    /** Successful atomic header/title observation. */
    status: 'fulfilled'
    /** Header and optional latest title from one logical source. */
    value: SessionTitleObservation
  }
  | {
    /** Requested session id. */
    sessionId: SessionId
    /** Operational failure isolated to this session. */
    status: 'rejected'
    /** Original failure from logical-source resolution or title folding. */
    reason: unknown
  }
```

```ts type-equiv
/** Lightweight metadata for one event within a logical session. */
interface SessionEventRecord {
  /** Session that owns the event. */
  sessionId: SessionId
  /** Monotonic event seq within the session. */
  seq: SessionSeq
  /** Discriminant of the session event. */
  type: SessionEventType
  /** Event timestamp in Unix epoch milliseconds. */
  time: number
  /** Event placement in the folded session surface. */
  surface: SessionEventSurface
}
```

## Provider-independent filters and documents

Session and event filter arrays are ANDed; values inside one list clause are ORed. Ranges are inclusive. The event `text` clause is a literal Unicode case-insensitive, whitespace-flexible regular-expression scan over extracted semantic text, independent of full-text providers.

```ts type-equiv
/**
 * One logical-session predicate. A filter array is ANDed; `values` within a
 * clause are ORed.
 */
type SessionResultFilter =
  | { kind: 'id'; values: readonly SessionId[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | ({ kind: 'created-at' } & SessionResultRange)
  | { kind: 'parent'; values: readonly (SessionId | null)[] }
  | { kind: 'availability'; values: readonly SessionAvailability[] }
```

```ts type-equiv
/**
 * One event predicate. A filter array is ANDed; list-valued clauses are ORed.
 * Text is a literal, case-insensitive, whitespace-flexible semantic-text scan.
 */
type SessionEventResultFilter =
  | ({ kind: 'seq' } & SessionResultRange)
  | ({ kind: 'time' } & SessionResultRange)
  | { kind: 'type'; values: readonly SessionEventType[] }
  | { kind: 'surface'; values: readonly SessionEventSurface[] }
  | { kind: 'text'; text: string }
```

```ts type-equiv
/** Searchable semantic document derived from one session event. */
interface SessionEventSearchDocument extends SessionEventRecord {
  /** First-party semantic text used by scan filters and full-text indexes. */
  text: string
}
```

`ctx.sessionQuery.filterSessions(filters)` applies `SessionResultFilter` to the complete logical corpus; `ctx.sessionQuery.filterEvents(sessionId, filters)` returns matching documents in ascending seq order. Messages, tool calls/results, todos, and failure/status detail contribute semantic text; reasoning blocks, blocked prompts, structural events, and stream chunks do not.

## Full-text search pages

The combined `ctx.sessionQuery` seam has two full-text scopes. `searchSessions()` groups the corpus by strongest matching event; `searchEvents()` searches one session. Requests bind an opaque cursor to the normalized query, metadata filters, and limit. The event text scan is intentionally absent from provider metadata filters.

```ts type-equiv
/** Provider-owned opaque continuation token returned by session search. */
type SessionSearchCursor = Branded<'SessionSearchCursor'>
```

```ts type-equiv
/** Cross-session full-text search request. */
interface SessionSearchRequest {
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string
  /** Logical-session predicates applied before event ranking. */
  sessionFilters?: readonly SessionResultFilter[]
  /** Event predicates applied before event ranking. */
  eventFilters?: readonly SessionEventMetadataFilter[]
  /** Maximum sessions in this page. */
  limit?: number
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor
}
```

```ts type-equiv
/** Within-session full-text search request. */
interface SessionEventSearchRequest {
  /** Session whose live-preferred logical log is searched. */
  sessionId: SessionId
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string
  /** Event predicates applied before ranking. */
  filters?: readonly SessionEventMetadataFilter[]
  /** Maximum events in this page. */
  limit?: number
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor
}
```

```ts type-equiv
/** How much of the logical corpus the indexed generation behind one page covers. */
interface SessionSearchCoverage {
  /**
   * `complete` when every Session in the observed corpus is indexed, `partial`
   * when at least one could not be read. A partial page cannot answer "this
   * does not exist", only "this was not found where it could be looked for".
   */
  status: 'complete' | 'partial'
  /** Sessions the indexed generation could not read. */
  skippedSessions: number
}
```

```ts type-equiv
/** One cursor-paginated result page. */
interface SessionSearchPage<T> {
  /** Results for this page in contract-defined order. */
  items: readonly T[]
  /** Opaque continuation cursor, absent on the final page. */
  nextCursor?: SessionSearchCursor
  /**
   * Coverage of the indexed generation this page was read from.
   *
   * Absent means the provider reported nothing about it, which is not
   * `complete`; a caller that needs the distinction must read absence as
   * unknown. The count covers the whole observed corpus, not the Sessions this
   * particular caller may see.
   */
  coverage?: SessionSearchCoverage
}
```

Unlike grouped cross-session hits, a within-session search must also expose its observed target header even when the page contains no hits.

```ts type-equiv
/** Event-search results bound to the indexed target-session observation. */
interface SessionEventSearchPage extends SessionSearchPage<SessionEventSearchHit> {
  /** Cloned target header from the same indexed generation as `items`. */
  session: SessionHeader
}
```

```ts type-equiv
/** One matched span inside a search excerpt, in UTF-16 code units of that excerpt. */
interface SessionEventMatchRange {
  /** Offset of the first matched code unit. */
  start: number
  /** Length of the match in code units. */
  length: number
}
```

```ts type-equiv
/** One event full-text search hit with a bounded plain-text excerpt. */
interface SessionEventSearchHit extends SessionEventRecord {
  /** Plain text excerpt selected around the match. */
  snippet: string
  /**
   * Matched spans inside `snippet`, in UTF-16 code units of that string.
   *
   * The provider reports them because it is the only layer that sees the
   * index's own marking; a renderer cannot recover the spans from the excerpt
   * after whitespace normalization and case folding.
   */
  matches?: readonly SessionEventMatchRange[]
}
```

```ts type-equiv
/** One grouped cross-session hit, ranked by its strongest matching event. */
interface SessionSearchHit extends SessionRecord {
  /** Strongest matching event for this session. */
  bestMatch: SessionEventSearchHit
}
```

## Index preparation

A search opens the index and compares the stored corpus with what that index already holds before it reads a page, so a caller that only sees the eventual response cannot distinguish a long preparation from a slow query. `searchIndexProgress()` reads the last state a backend published without starting a pass, and `session-query/index-progress` reports each later state: `opening` while the backend opens, `reconciling` while it decides each stored Session, and `ready` once that pass finished.

```ts type-equiv
/**
 * Observable preparation of the full-text index that a search reads through.
 *
 * Every search first opens the index and compares the stored corpus with what
 * the index already holds. That wait, not the query, is what a caller otherwise
 * has to report as one undifferentiated "searching" state.
 *
 * This counts preparation work; it is not {@link SessionSearchCoverage}, which
 * reports how much of the observed corpus the finished generation covers. A
 * completed pass here can still end with unreadable Sessions left out.
 */
interface SessionSearchIndexProgress {
  /**
   * `opening` while the backend module and handle open, `reconciling` while the
   * observed corpus is compared with the index, and `ready` once the pass
   * finished. A pass that fails reports nothing further, so the last value
   * stays published until the next search starts another pass.
   */
  phase: 'opening' | 'reconciling' | 'ready'
  /**
   * Stored Sessions this pass finished deciding, skipped ones included. Live
   * Sessions are observed in memory and are not part of a pass, so this counts
   * the stored corpus only.
   */
  examined: number
  /** Stored Sessions the persistence backend listed for this pass; `0` until that listing returns. */
  total: number
  /** Examined Sessions whose stored revision matched the indexed one, so their logs were not read again. */
  skipped: number
}
```

A backend that opens at activation reports nothing for that open, because no search waits on it; the first search then starts at `reconciling`. A pass decides a bounded batch of stored Sessions, publishes, and yields the event loop between batches, so those reports reach a listener while the search that waits for them is still unanswered. The SQLite backend sizes that batch with `reconcileBatchSize`; skipping is how a pass costs almost nothing when no stored revision moved, and it is not coverage: a pass that ends `ready` with `examined === total` can still report `SessionSearchCoverage` as `partial`.

## Session lineage

`SessionLineageTrace` carries known parents in immediate-to-outward order and a forest of recursively nested direct descendants. The completeness discriminant makes a known root and a missing parent mutually exclusive.

```ts type-equiv
/** Recursive descendant node in a session-lineage trace. */
interface SessionLineageNode {
  /** Detached logical-corpus record for this descendant. */
  session: SessionRecord
  /** Direct children, each carrying its own recursive descendants. */
  descendants: SessionLineageNode[]
}
```

```ts type-equiv
/** Known ancestry and descendants for one logical session. */
type SessionLineageTrace = {
  /** Detached record for the session that was traced. */
  target: SessionRecord
  /** Known parents from the immediate parent outward. */
  ancestors: SessionRecord[]
  /** Complete known descendant trees rooted at the target's direct children. */
  descendants: SessionLineageNode[]
} & (
  | {
    /** The complete parent chain is present in the logical corpus. */
    complete: true
    /** Detached record at the top of the complete lineage. */
    root: SessionRecord
  }
  | {
    /** The parent chain leaves the visible logical corpus. */
    complete: false
    /** First parent id that is not present in the logical corpus. */
    unresolvedParentId: SessionId
  }
)
```

## Bounded event reads

The request addresses one raw seq and optional neighboring counts. The result carries a `SessionHeader` rather than availability flags so a known live target can remain independent of persistence health.

```ts type-equiv
/** Request for one event plus raw neighboring log context. */
interface SessionEventReadRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: SessionSeq
  /** Number of preceding raw events to include. */
  before?: number
  /** Number of following raw events to include. */
  after?: number
}
```

```ts type-equiv
/** Full target event and a bounded raw-log window. */
interface SessionEventWindow {
  /** Cloned header for the live-preferred source read. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Full cloned target event. */
  target: SessionEvent
  /** Full cloned events from `startSeq` through `endSeq`. */
  events: SessionEvent[]
  /** First seq included in `events`. */
  startSeq: SessionSeq
  /** Last seq included in `events`. */
  endSeq: SessionSeq
}
```

## Event relationships

Event traces distinguish positional surface replacement from events cited as sources. Every seq list contains direct links except `replacementChain`, which follows immediate replacers from the target to the final positional replacement.

```ts type-equiv
/** Request for direct surface replacements and relationships to cited source events around one event. */
interface SessionEventTraceRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: SessionSeq
}
```

```ts type-equiv
/** Direct surface replacements and relationships to cited source events for one event. */
interface SessionEventTrace {
  /** Lightweight target record. */
  target: SessionEventRecord
  /** Immediate positional replacement event, when the target was shadowed. */
  replacedBy?: SessionSeq
  /** Positional replacers from the immediate replacement to the final replacement. */
  replacementChain: SessionSeq[]
  /** Surface nodes directly removed when the target itself performed a replacement. */
  replacedEventSeqs: SessionSeq[]
  /** Earlier events cited directly as sources, in their recorded order. */
  sourceEventSeqs: SessionSeq[]
  /** Later events that directly cite the target as a source, in log order. */
  derivedEventSeqs: SessionSeq[]
}
```

```ts type-equiv
/** Event relationships bound to the same session-header observation. */
interface SessionEventTraceObservation extends SessionEventTrace {
  /** Cloned header selected with the event log used for the trace. */
  session: SessionHeader
}
```

## Errors

The closed code union distinguishes request validation, missing targets, malformed surface logs, optional-backend failure, deployment-disabled search, and contradictory source metadata.

```ts type-equiv
/** Stable machine-routable failure taxonomy for session reads, traces, and search. */
type SessionQueryErrorCode =
  | 'SESSION_QUERY_ABORTED'
  | 'SESSION_QUERY_CORRUPT_SESSION'
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INDEX_FAILED'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_CURSOR'
  | 'SESSION_QUERY_INVALID_FILTER'
  | 'SESSION_QUERY_INVALID_LIMIT'
  | 'SESSION_QUERY_INVALID_QUERY'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SEARCH_DISABLED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_STALE_CURSOR'
  | 'SESSION_QUERY_SOURCE_CONFLICT'
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionquery--sessionqueryengine-abstract-seam"></a>

### `ctx.sessionQuery` — `SessionQueryEngine` (abstract seam)

Unified live-preferred session query service.

Exact reads, filters, and traces are backend-independent concrete behavior. A backend implements full-text observation, reconciliation, ranking, cursor generations, and query execution on the same `ctx.sessionQuery` service.

```ts cordis-catalog
/**
 * Observe one exact live or prepared Session without a persistence listing preflight.
 * @param sessionId - logical Session identity.
 * @param options - cancellation and projection selection for this read.
 * @returns a caller-owned observation lease.
 */
observeSession( sessionId: SessionId, options: SessionObservationOptions = {}, ): Promise<SessionObservation>

/**
 * Read the last preparation state this backend published, without starting one.
 *
 * A search waits for this preparation before it queries, so a caller that can
 * observe it can report how long that wait still is instead of one
 * undifferentiated "searching" state.
 * @returns the last reported progress, or `undefined` when this backend has
 *   not started preparing an index: no full-text backend is mounted, search is
 *   disabled, or the configured policy defers opening until the first search.
 */
searchIndexProgress(): SessionSearchIndexProgress | undefined

/**
 * Search the live-preferred logical corpus and group by session.
 * @param request - query text, metadata filters, page size, and cursor.
 * @param exec - optional cancellation control.
 * @returns session hits ranked by their strongest matching event.
 */
abstract searchSessions( request: SessionSearchRequest, exec?: SessionSearchExecContext, ): Promise<SessionSearchPage<SessionSearchHit>>

/**
 * Search events within one live-preferred logical session.
 * @param request - target session, query text, filters, page size, and cursor.
 * @param exec - optional cancellation control.
 * @returns matching event hits and their target header from one indexed generation.
 */
abstract searchEvents( request: SessionEventSearchRequest, exec?: SessionSearchExecContext, ): Promise<SessionEventSearchPage>

/**
 * Search the live-preferred logical corpus at message granularity.
 *
 * Where {@link searchSessions} keeps one strong event per session, this
 * returns the matching events themselves, so a caller that needs to address
 * a specific message reads `sessionId` and `seq` off each hit instead of a
 * session-level summary. It matches literal text rather than searchable
 * words, because a message is prose: every whitespace-separated term must
 * appear somewhere in the message, in any order and at any distance, and a
 * term reaches the middle of a word as readily as its start.
 *
 * Hits cover what a reader can see: the text blocks of `user/message` and
 * `assistant/message`. Tool calls, reasoning, and the checkpoint a
 * compaction injects are the run's scaffolding and never match.
 * @param request - query text, metadata filters, page size, and cursor.
 * @param exec - optional cancellation control.
 * @returns matching event hits in contract-defined order.
 */
abstract searchMessages( request: SessionMessageSearchRequest, exec?: SessionSearchExecContext, ): Promise<SessionSearchPage<SessionEventSearchHit>>

/**
 * List the complete logical corpus using live-preferred records.
 * @param signal - optional cancellation for persistence listing.
 * @returns deterministic newest-first cloned session records.
 */
listSessions(signal?: AbortSignal): Promise<SessionRecord[]>

/**
 * Read and replay-validate one complete logical session log without making it live.
 * @param sessionId - live or persisted session id to read.
 * @returns cloned header and complete raw event log from one observation.
 * @throws when persistence, header compatibility, or replay validation fails.
 */
async readSession(sessionId: SessionId): Promise<SessionLogSnapshot>

/**
 * Filter the complete logical corpus with provider-independent predicates.
 * @param filters - ANDed session metadata and availability clauses.
 * @param signal - optional cancellation for persistence listing.
 * @returns matching cloned records in deterministic newest-first order.
 */
async filterSessions( filters: readonly SessionResultFilter[], signal?: AbortSignal, ): Promise<SessionRecord[]>

/**
 * Fold the latest log-backed title from one live-preferred logical session.
 * @param sessionId - live or persisted session id to read.
 * @param signal - optional cancellation for source resolution and title folding.
 * @returns latest title snapshot, or `undefined` when the log has no title event.
 */
async readTitle( sessionId: SessionId, signal?: AbortSignal, ): Promise<SessionTitleSnapshot | undefined>

/**
 * Fold the latest title and return its source header from one corpus observation.
 * @param sessionId - live or persisted session id to read.
 * @param signal - optional cancellation for source resolution and title folding.
 * @returns cloned source header and optional latest title snapshot.
 */
async readTitleSnapshot( sessionId: SessionId, signal?: AbortSignal, ): Promise<SessionTitleObservation>

/**
 * Fold titles for unique sessions from one cancellable corpus observation.
 *
 * Results preserve first-occurrence input order. Operational failures stay
 * isolated per session, while cancellation rejects the complete operation.
 * @param sessionIds - live or persisted session ids to observe.
 * @param signal - optional cancellation shared by all source reads.
 * @returns one fulfilled or rejected result per unique requested id.
 */
async readTitleSnapshots( sessionIds: readonly SessionId[], signal?: AbortSignal, ): Promise<SessionTitleObservationResult[]>

/**
 * List lightweight raw-log event records for one logical session.
 * @param sessionId - live-preferred session id to read.
 * @returns event records in ascending seq order.
 */
async listEvents(sessionId: SessionId): Promise<SessionEventRecord[]>

/**
 * Scan first-party semantic event documents with provider-independent filters.
 * @param sessionId - live-preferred session id to scan.
 * @param filters - ANDed metadata and literal-text predicates.
 * @returns matching semantic documents in ascending seq order.
 */
async filterEvents( sessionId: SessionId, filters: readonly SessionEventResultFilter[], ): Promise<SessionEventSearchDocument[]>

/**
 * Read one session's complete current model surface from one corpus observation.
 * @param sessionId - live-preferred session id to read.
 * @returns cloned header, current surface, and the last sequence number included in the raw-log capture.
 * @throws when source resolution fails or the session surface is invalid.
 */
async readSurface(sessionId: SessionId): Promise<SessionSurfaceSnapshot>

/**
 * Trace known ancestry and descendants from one corpus observation.
 * @param sessionId - logical session id to trace.
 * @param signal - optional cancellation for persistence listing.
 * @returns a complete lineage or the first parent that could not be resolved.
 * @throws when corpus resolution fails, the target is absent, or its known ancestry cycles.
 */
async traceSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLineageTrace>

/**
 * Trace one event's direct positional replacements and cited source events.
 * @param request - target session id and event seq.
 * @param signal - optional cancellation for persisted source resolution.
 * @returns source header, direct links, and the target's positional replacement chain.
 * @throws when source resolution fails, the target is absent, or surface/source-event validation fails.
 */
async traceEvent(request: SessionEventTraceRequest, signal?: AbortSignal): Promise<SessionEventTraceObservation>

/**
 * Read one full event plus a bounded raw-log context window.
 * @param request - target session/seq and context sizes.
 * @param signal - optional cancellation for persisted source resolution.
 * @returns cloned target and neighboring events.
 */
async readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow>
```

Types: [SessionId](core.md) · [SessionTitleSnapshot](session-title.md)

Source: [`packages/session-query/session-query/src/index.ts`](../../packages/session-query/session-query/src/index.ts)

<a id="session-query-events"></a>

### `session-query/*` events

<a id="session-queryindex-progress--emit"></a>

#### `session-query/index-progress` — emit

Preparation of the full-text index behind session search advanced.

```ts cordis-catalog
/**
 * Preparation of the full-text index behind session search advanced.
 * @mode emit
 * @param progress - phase and counters after the advance.
 */
'session-query/index-progress'(progress: SessionSearchIndexProgress): void
```

Source: [`packages/session-query/session-query/src/index.ts`](../../packages/session-query/session-query/src/index.ts)
<!-- END GENERATED cordis-surface -->
