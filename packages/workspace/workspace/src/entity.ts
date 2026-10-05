/**
 * Package-private workspace entity: the single {@link Workspace}
 * implementation. Holds a record snapshot that is swapped in place after each
 * durable mutation; every write funnels through the private `mutate` so
 * `updatedAt` stamping and invalid-account pruning happen exactly once.
 * Not re-exported from the package entrypoint — consumers see only the
 * `Workspace` interface.
 * @module @deepseek-ai/dsh-workspace/src/entity
 */

import { stat } from 'node:fs/promises'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceRecord } from './spec.ts'
import type { Workspace, WorkspaceId } from './types.ts'
import { realpathNormalize } from './paths.ts'

/** An insertSessionBefore request named a session or anchor not on the account (storage failures stay plain errors). */
export class WorkspaceMoveInvalidError extends Error {
  /**
   * @param message - Which id was unaccounted and where.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMoveInvalidError'
  }
}

/**
 * The registry-owned machinery an entity mutates through. Entities never see
 * the registry itself — only the open table, the canonical session-path
 * index backing the `sessionIds` projection, attach-time header reads, and
 * the registry's mutation queue.
 */
export interface WorkspaceEntityHost {
  /**
   * Resolve the open `workspaces` table.
   * @returns the table; throws while the registry has not started yet.
   */
  table(): KvTable<WorkspaceId, WorkspaceRecord>

  /**
   * Read a session's canonical directory from the registry's header index.
   * @param id - Session whose indexed path is requested.
   * @returns the canonical directory, or `undefined` when the header is
   * missing or its cwd cannot identify an existing directory.
   */
  sessionPath(id: SessionId): string | undefined

  /**
   * Read one stored session header for attach validation.
   * @param id - The session whose header to read.
   * @returns the header; rejects when session persistence is absent or holds
   * no session with this id.
   */
  readSessionHeader(id: SessionId): Promise<SessionHeader>

  /**
   * Whether the header index still holds this header object for its
   * session. A relocation replaces the indexed header without waiting for
   * the mutation queue.
   * @param header - A header {@link readSessionHeader} returned.
   * @returns `true` while no relocation has replaced it.
   */
  indexesHeader(header: SessionHeader): boolean

  /**
   * Publish a successfully validated canonical cwd to the projection index.
   * @param id - Validated session id.
   * @param path - Canonical existing directory from the stored header cwd.
   */
  rememberSessionPath(id: SessionId, path: string): void

  /**
   * Durably detach a session from every other workspace record that lists
   * it; called only inside a mutation-queue slot.
   * @param id - Session about to be accounted by `keep`.
   * @param keep - The workspace that keeps or gains the session.
   * @returns resolution after every detach is durable.
   */
  detachElsewhere(id: SessionId, keep: WorkspaceId): Promise<void>

  /**
   * Run an operation on the registry's mutation queue, after every registry
   * operation queued before it settles. Every operation that adds a session
   * to a record runs there.
   * @param operation - The work to run in the queue slot.
   * @returns the operation's result.
   */
  enqueue<T>(operation: () => Promise<T>): Promise<T>
}

/** Chain-slot abort sentinel thrown by the update fn when the record needs no change; only `mutate` observes it. */
const unchangedSentinel = new Error('workspace record unchanged (internal sentinel)')

/** The single {@link Workspace} implementation; constructed only by the registry. */
export class WorkspaceEntity implements Workspace {
  private record: WorkspaceRecord

  /**
   * @param host - Registry-owned table, session-path index, and header reads.
   * @param id - The record's stable id.
   * @param record - The validated record snapshot loaded or just written.
   */
  constructor(
    private readonly host: WorkspaceEntityHost,
    readonly id: WorkspaceId,
    record: WorkspaceRecord,
  ) {
    this.record = record
  }

  get path(): string {
    return this.record.path
  }

  get title(): string {
    return this.record.title
  }

  get createdAt(): string {
    return this.record.createdAt
  }

  get updatedAt(): string {
    return this.record.updatedAt
  }

  get sessionIds(): readonly SessionId[] {
    return this.record.sessionIds.filter(id => this.host.sessionPath(id) === this.record.path)
  }

  async setTitle(title: string): Promise<void> {
    await this.mutate(record => ({ ...record, title }))
  }

  async attachSession(sessionId: SessionId): Promise<void> {
    // Unlike the other entity writes, this waits for the registry's mutation
    // queue, so a detach issued before it settles can land first.
    await this.host.enqueue(() => this.attachQueued(sessionId))
  }

  /**
   * The body of {@link attachSession}, for a caller that already holds a
   * registry mutation-queue slot. Only queued operations add a session to a
   * record, so no other record can gain the session between the detach
   * writes and this record's write.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  async attachQueued(sessionId: SessionId): Promise<void> {
    // Validation is skipped when the settled snapshot already accounts the
    // id: the cwd fact was checked when it first attached, and the workspace
    // path changes only at registry startup, before any entity exists. A
    // stored header cwd changes only through `session-persistence/relocated`;
    // the registry swaps its index entry before any await, and the filter in
    // `mutate` drops every id whose indexed path differs from this workspace.
    // Whether the record lists the id is decided again at its write-chain
    // slot inside `mutate`.
    if (!this.record.sessionIds.includes(sessionId)) {
      const cwd = await this.validatedCwd(sessionId)
      this.host.rememberSessionPath(sessionId, cwd)
      // Workspace paths are unique, so every other record listing the session
      // names a stale location. Detaching first keeps each session in at most
      // one record even when this process dies between the two writes.
      await this.host.detachElsewhere(sessionId, this.id)
    }
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? record
      : { ...record, sessionIds: [sessionId, ...record.sessionIds] })
  }

  /**
   * Validate the session's indexed header cwd against this workspace. A
   * verdict counts only for the header the index still holds when it is
   * reached: when a relocation replaced the header during the file-system
   * reads, the replacement is validated in its place.
   */
  private async validatedCwd(sessionId: SessionId): Promise<string> {
    for (;;) {
      const header = await this.host.readSessionHeader(sessionId)
      let cwd: string | undefined
      let failure: unknown
      try {
        cwd = await this.resolveCwd(sessionId, header)
      } catch (error: unknown) {
        failure = error
      }
      if (!this.host.indexesHeader(header)) continue
      if (cwd === undefined) throw failure
      return cwd
    }
  }

  /** Resolve a header cwd to this workspace's path, rejecting every other outcome. */
  private async resolveCwd(sessionId: SessionId, header: SessionHeader): Promise<string> {
    if (header.cwd === undefined) {
      throw new Error(
        `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
        + 'its stored header carries no cwd to validate against',
      )
    }
    let cwd: string
    try {
      cwd = await realpathNormalize(header.cwd)
    } catch (error) {
      throw new Error(
        `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
        + `its cwd '${header.cwd}' does not resolve, so it cannot be validated`,
        { cause: error },
      )
    }
    if (!(await stat(cwd)).isDirectory()) {
      throw new Error(
        `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
        + `its cwd '${header.cwd}' is not a directory`,
      )
    }
    if (cwd !== this.record.path) {
      throw new Error(
        `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
        + `its cwd resolves to '${cwd}'`,
      )
    }
    return cwd
  }

  async insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void> {
    await this.mutate((record) => {
      if (!record.sessionIds.includes(sessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' in workspace '${record.path}': the session is not accounted`,
        )
      }
      if (beforeSessionId !== undefined && !record.sessionIds.includes(beforeSessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${record.path}': `
          + 'the anchor session is not accounted',
        )
      }
      if (beforeSessionId === sessionId) return record
      const without = record.sessionIds.filter(id => id !== sessionId)
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
      return sessionIds.every((id, index) => id === record.sessionIds[index])
        ? record
        : { ...record, sessionIds }
    })
  }

  async detachSession(sessionId: SessionId): Promise<void> {
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? { ...record, sessionIds: record.sessionIds.filter(id => id !== sessionId) }
      : record)
  }

  async status(): Promise<'ok' | 'missing-dir'> {
    try {
      return (await stat(this.record.path)).isDirectory() ? 'ok' : 'missing-dir'
    } catch {
      // Any stat failure (ENOENT, dangling parent, permission loss) means the
      // directory is not usable right now; the record itself never mutates.
      return 'missing-dir'
    }
  }

  /**
   * The single write path: run `fn` on the domain write chain via
   * `table.update`, stamping `updatedAt` and pruning candidates that no
   * longer pass the id-plus-canonical-cwd membership check, then swap the
   * snapshot.
   *
   * `fn` sees the value current at its chain slot, so membership decisions
   * (attach/detach idempotence) are race-free against queued writes; a fn
   * signalling no change by returning `current` verbatim aborts the slot
   * through the sentinel when pruning also finds nothing, so a no-op neither
   * rewrites the medium nor emits a change event.
   */
  private async mutate(fn: (record: WorkspaceRecord) => WorkspaceRecord): Promise<void> {
    let next: WorkspaceRecord
    try {
      next = await this.host.table().update(this.id, (current) => {
        const changed = fn(current)
        const sessionIds = changed.sessionIds.filter(
          id => this.host.sessionPath(id) === changed.path,
        )
        if (changed === current && sessionIds.length === current.sessionIds.length) {
          throw unchangedSentinel
        }
        return { ...changed, sessionIds, updatedAt: new Date().toISOString() }
      })
    } catch (error) {
      if (error === unchangedSentinel) return
      throw error
    }
    this.record = next
  }
}
