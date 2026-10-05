/**
 * Durable session-persistence Service Definition (`ctx.sessionPersistence`). Backends store
 * {@link SessionEvent}s as the event-sourced log and carry non-replayable
 * {@link SessionHeader} metadata separately; callers address one stored
 * session through a {@link SessionHandle} obtained from `create`/`open`.
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionAccess } from './handle.ts'
import type { SessionPersistenceRevision } from './revision.ts'

// Re-export the metadata vocabulary so Consumers import it from the Service Definition.
export type { SessionHeader } from '@deepseek-ai/dsh-session'
export { SessionPersistenceRevision } from './revision.ts'
export type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
} from './handle.ts'
export {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  sessionFormatVersionRefusal,
} from './errors.ts'
export type { SessionLocation } from './errors.ts'
export {
  assertContiguous,
  assertStoredId,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
} from './storage-contract.ts'

/**
 * Lightweight stored-session observation returned by {@link SessionPersistence.stat}
 * and {@link SessionPersistence.list} without reading the full event log.
 */
export interface SessionPersistenceSnapshot {
  /** Detached metadata for one stored session. */
  readonly header: SessionHeader
  /** Opaque change token; see {@link SessionPersistence.stat}. */
  readonly revision: SessionPersistenceRevision
  /** Logical event count, when the backend can provide it cheaply from metadata; otherwise absent. */
  readonly eventCount?: number
  /** Physical artifact byte size, when the backend can provide it cheaply (JSONL); otherwise absent. */
  readonly sizeBytes?: number
}

/** Options for {@link SessionPersistence.create}. */
export interface SessionPersistenceCreateOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal
  /**
   * Exact fork-inherited prefix length. Required when `header.isSeeded` is
   * true and must be omitted (or `0`) otherwise; the backend refuses a
   * mismatch at create.
   */
  readonly inheritedEventCount?: SessionLogOffset
}

/**
 * Logical Session header paired with its exact inherited cut for body-bearing
 * storage operations. `isSeeded` marks fork lineage on the header; the
 * numeric cut travels beside it, never inside the replayable event log.
 */
export interface SessionStorageMetadata {
  /** Validated immutable Session header. */
  readonly meta: SessionHeader
  /** Number of leading events inherited from the Session's fork parent. */
  readonly inheritedEventCount: SessionLogOffset
}

/** Immutable logical session read: storage metadata plus the complete validated event log. */
export interface SessionInspection extends SessionStorageMetadata {
  /** Contiguous validated events from seq 0. */
  readonly events: readonly SessionEvent[]
}

/** Options for {@link SessionPersistence.open}. */
export interface SessionPersistenceOpenOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal
}

/** Options for {@link SessionPersistence.stat}. */
export interface SessionPersistenceStatOptions {
  /** Optional cancellation for backend metadata reads. */
  readonly signal?: AbortSignal
}

/** Options for {@link SessionPersistence.list}. */
export interface SessionPersistenceListOptions {
  /** Optional cancellation for backend listing work. */
  readonly signal?: AbortSignal
}

/** Options for {@link SessionPersistence.relocate}. */
export interface SessionPersistenceRelocateOptions {
  /** Optional cancellation, observed until the target generation is published. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
  }

  interface Events {
    /**
     * A stored session moved to another storage location and its header cwd
     * changed. Emitted once per successful relocate, after the backend released
     * its write ownership; recovery of an interrupted move emits nothing.
     * Listeners run synchronously in registration order, must not throw, and
     * must catch their own asynchronous failures. Cordis `emit` does not
     * isolate listeners: one that throws stops the dispatch, and every
     * listener after it misses the event. The relocation still succeeds and
     * the backend logs a warning. A consumer that tracks sessions by cwd
     * therefore reconciles from the stored headers when it starts; the
     * workspace registry detaches a session listed at its old path then.
     * @mode emit
     * @param id - the relocated session.
     * @param previous - the stored header before the move.
     * @param current - the snapshot after the move (new cwd, new revision).
     */
    'session-persistence/relocated'(id: SessionId, previous: SessionHeader, current: SessionPersistenceSnapshot): void
  }
}

/**
 * Durable append-only session storage addressed through per-session handles.
 *
 * Storage semantics shared by every backend: events are contiguous from seq 0
 * and never rewritten; a torn physical tail is never returned to a reader and
 * is truncated by the write path before its first append; reads validate
 * current-format records only and refuse unknown vocabulary fail-closed.
 * `append` persists best-effort; `flush` — per handle or service-wide — is
 * the durability barrier.
 *
 * Visibility: a created session is observable through `stat`/`list`/`open`
 * in this process from the moment `create` resolves, even while a backend
 * defers physical materialization (a pure optimization); other processes see
 * the session only once it materializes, and a session that never
 * materialized before a crash never existed. `SessionHandle.flush` forces
 * materialization.
 *
 * Freshness: once an `append` or `flush` resolves, reads started afterwards
 * on this backend instance observe at least that prefix.
 *
 * Relocation: a backend may implement the optional `relocate`, which moves a
 * stored session to the storage location of another cwd. Other processes see
 * the session at its old location, then at neither while the move is between
 * the two, then at its new one; a move interrupted between the two leaves the
 * session absent until the backend recovers that move. While the session is
 * absent, `stat` returns `undefined`, `list` omits it, and an `open` or a
 * handle read that consults storage rejects with
 * `SessionPersistenceNotFoundError`. An `open` or a handle read that located
 * the old storage just before the move rejects with the backend's own error
 * for vanished storage, as when any stored file vanishes (`ENOENT` for the
 * JSONL backend). A read handle may stay open across the move: later reads
 * observe the new location, and its `header` keeps the value it had at open.
 */
export abstract class SessionPersistence extends Service {
  /** Process-local instance identity, stable through Context proxies and distinct after service replacement. */
  readonly identity: symbol = Symbol('sessionPersistence')

  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /**
   * Create a new stored session and take its write ownership.
   * @param header - the header (id, version, cwd, lineage) to store; only
   *   `relocate` later replaces its cwd.
   * @param options - optional cancellation.
   * @returns a `write` handle owned by the caller; close it to release ownership.
   * @throws {SessionAlreadyExistsError} when the id already exists.
   */
  abstract create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle>

  /**
   * Open an existing stored session.
   *
   * `read` never takes ownership and works while another handle (or process)
   * holds write ownership. `write` atomically claims single-writer ownership;
   * an existing active owner rejects.
   * @param id - the stored session to open.
   * @param access - `read` or `write`.
   * @param options - optional cancellation.
   * @returns the open handle.
   * @throws {SessionPersistenceNotFoundError} when the session does not exist.
   * @throws {SessionAlreadyOwnedError} for `write` when ownership is taken.
   */
  abstract open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>

  /**
   * Flush every active write handle owned by this service instance in one
   * durability barrier: each handle's routed live events drain durably and
   * its session materializes, exactly as that handle's own
   * `SessionHandle.flush` would. Read handles buffer nothing and are
   * untouched. A handle closed concurrently counts as flushed — close itself
   * drains durably.
   * @returns resolution once every write handle active at the call has flushed.
   * @throws {AggregateError} naming each session whose flush failed; the
   *   remaining handles still flush.
   */
  abstract flush(): Promise<void>

  /**
   * Observe one stored session without reading its event log or taking
   * ownership.
   *
   * The snapshot's `revision` is an opaque change token comparable only
   * against revisions from the same service instance and session id: equal
   * revisions may be treated as an unchanged log; unequal revisions promise
   * nothing. Write-ownership churn does not change a revision. It exists for
   * derived read-model caches keyed off `stat`/`list`; it plays no part in
   * open, read, or resume.
   * @param id - the stored session to observe.
   * @param options - optional cancellation.
   * @returns the snapshot, or `undefined` when the session does not exist.
   */
  abstract stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>

  /**
   * List every stored session visible to this process, in no promised order.
   * @param options - optional cancellation.
   * @returns one snapshot per stored session.
   */
  abstract list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>

  /**
   * Move a stored session to the storage location of `cwd` and replace its
   * header cwd. The id, `createdAt`, lineage, `isSeeded`, inherited cut,
   * events, and seqs stay unchanged; the returned snapshot carries a new
   * revision. When the stored cwd already equals `cwd` (exact string
   * comparison) nothing changes, no event fires, and the current snapshot
   * returns, so a caller that crashed may repeat the call. Pass exactly the
   * cwd later resumes will pass: resume compares cwd strings exactly.
   *
   * Optional: callers test `typeof ctx.sessionPersistence.relocate ===
   * 'function'` first. A write handle held by this or another process, or a
   * pending create in this process, refuses the move; read handles may stay
   * open. Success emits `session-persistence/relocated` after write ownership
   * is released. A listener that throws does not fail the move: the backend
   * logs a warning, and the listeners after it miss the event.
   * @param id - the stored session to move.
   * @param cwd - the absolute working directory the session moves to.
   * @param options - optional cancellation, observed until the target
   *   generation is published; a cancelled move rolls back.
   * @returns the snapshot after the move.
   * @throws {TypeError} when `cwd` is not absolute.
   * @throws {SessionPersistenceNotFoundError} when the session does not exist.
   * @throws {SessionAlreadyOwnedError} while a write handle or pending create
   *   holds the session, or another holder keeps the source or target
   *   location, including an unfinished earlier move of the same session.
   * @throws {SessionFormatUnsupportedError} when the stored log is newer than
   *   this build.
   * @throws {SessionPersistenceCorruptionError} when the stored log cannot be
   *   decoded, the target location already holds a log, another location
   *   gained a session with the same id while this one was absent during the
   *   move, or an unfinished earlier move of the same session is malformed or
   *   contradicts the storage; when a move stays unfinished, the message
   *   names the backend's record of it.
   * @throws {Error} when the source and target locations are on different
   *   filesystems.
   */
  relocate?(id: SessionId, cwd: string, options?: SessionPersistenceRelocateOptions): Promise<SessionPersistenceSnapshot>
}

export default SessionPersistence
