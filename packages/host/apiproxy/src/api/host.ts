/**
 * host domain contract. No protocol version: client and host ship
 * together; introduce protocolVersion only when an independently released client appears.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One directory row of a listing: a child entry or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
}

/** host.listDirectory response value: one directory level plus its ancestry. */
export interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string
  /**
   * Ancestor chain from the filesystem root to the listed directory
   * inclusive; every crumb is a jump target (crumb `hidden` is always false).
   */
  crumbs: DirectoryEntry[]
  /** Direct child directories, name-sorted; symlinks to directories included. */
  entries: DirectoryEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
}

/** Host-level unary methods. */
export interface HostApi {
  /**
   * One-shot host snapshot. Empty payload uses the literal `{}` (extend in place when fields arrive).
   * version = the host app's (apps/cli) package.json version; cwd = the host process working
   * directory (root for session persistence and tool execution); provider/model = the defaults
   * applied when a new agent doesn't specify them explicitly, absent when the host configures
   * no explicit default (the adapter falls back internally);
   * attachedSessions = count of currently attached sessions (those with a live agent);
   * home = the host account home directory (Web display abbreviation on POSIX);
   * canOpenPath = whether this deployment can hand a path to a user-visible native desktop.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
    home: string
    canOpenPath: boolean
  }>>

  /**
   * Open the operating system's single-directory picker; cancellation returns
   * null. Only served under the `native` capability.
   */
  pickDirectory(
    request: RpcRequest<{}>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ path: string | null }>>

  /**
   * List one directory level for the in-app browser; an absent path lists the
   * host account's home directory. Only served under the `browse` capability;
   * unreadable or missing targets fail with `directory-unreadable`. The
   * carrier's request signal follows the caller, stopping the backend's scan
   * on disconnect or timeout.
   */
  listDirectory(
    request: RpcRequest<{ path?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<DirectoryListing>>

  /**
   * Create one child directory under an existing parent (the browser's
   * "New folder"). Only served under the `browse` capability; an existing
   * child fails with `directory-exists`, every other filesystem failure with
   * `directory-create-failed`.
   */
  createDirectory(
    request: RpcRequest<{ path: string; name: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /**
   * Open a filesystem path with the operating system's default application
   * (Finder / Explorer / xdg-open hand-off). The browser carrier's
   * prefix-wide trust fence covers this privileged method like every other
   * `/api` request. A path that does not resolve on disk fails with
   * `not-found`; every other opener failure (permission, no registered
   * application) fails with `internal`.
   */
  openPath(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>>

  /**
   * Batch existence/kind probe for the three-layer clickable-reference
   * verification stage: a read-only `stat` per path, never a directory
   * listing or a content read. Always available — unlike
   * `listDirectory`/`pickDirectory`, this is not gated behind the
   * `browse`/`native` directory-picker capability, since it makes no
   * filesystem choice a deployment might want to withhold beyond what
   * `openPath`'s own pre-check already performs per path. Capped at 64
   * paths per call (a larger batch fails `bad-request`) and run with bounded
   * internal concurrency, so a caller with more candidates issues several
   * calls rather than one unbounded one.
   */
  probeTargets(
    request: RpcRequest<{ paths: string[] }>,
  ): Promise<RpcResponse<{ results: ProbeResult[] }>>
}

/** One `host.probeTargets` result, in the same order as its request's `paths`. */
export interface ProbeResult {
  /** Echoes the probed path exactly as requested. */
  path: string
  /**
   * False for ENOENT and for any other `stat` failure (permission, a
   * non-directory path segment, …) — the probe answers "clickable or not,"
   * not "why not."
   */
  exists: boolean
  /** Present only when `exists` is true. */
  kind?: 'file' | 'dir'
}
