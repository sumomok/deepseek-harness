# Agent Note: A distinguishable not-found error from the path opener

Status: implemented

English | [中文](2026-08-27-host-open-target-not-found.zh.md)

## Problem

`openWorkspacePath` in `dsh-api-session-controller` (the Remote method behind opening a workspace path from the browser conversation UI) collapsed every opener failure — a path that does not exist, no registered application, denied permission, a missing platform command — into one `gateway/internal` error carrying only a free-text message. A caller could not distinguish "this path does not exist" from any other failure without parsing message text, which is not a contract the message ever promised. A separate `settings-controller` copy of the same opener handoff (the settings-document text-editor path) is an independent implementation, out of this decision's scope.

## Decision

`openWorkspacePath` checks the resolved path with `stat` before invoking the native opener. An `ENOENT` answers the closed `RemoteError` code `session/path-not-found` with `{ path }` in `details`; every other `stat` failure (permission, a non-directory path segment, a transient Windows sharing violation) falls through unchanged, and every opener failure still folds into the existing `gateway/internal`/`gateway/cancelled` handling. The check runs ahead of the opener call because the opener is a shelled-out platform command (`open`, `xdg-open`, PowerShell's `Invoke-Item`), never a Node fs call — it never raises a `NodeJS.ErrnoException` this process could read a reliable code from, and each platform's own "no such file" text is unstructured and unparsed. A pre-check is the only approach that answers the same way on every platform.

Because `stat` is itself an await, a caller's abort landing while it is in flight would otherwise reach the opener already-fired: an opener that only listens for the live `abort` DOM event (rather than also polling `signal.aborted` up front) would then never observe it and the request would hang. `openWorkspacePath` re-checks `signal.aborted` immediately after the `stat` pre-check and before invoking the opener, so an abort during the existence check still answers `gateway/cancelled`.

`session/path-not-found` is a new row in `RemoteErrorDetailsMap` (`packages/api/session-controller/src/types.ts`), so it flows through the same closed-union `RemoteError<'domain/code'>` validation every other Remote error code does. `openWorkspacePath` throws this `RemoteError` directly — the RPC layer resolves it to `{ok: false, error: RemoteError}` on the client, so a caller reads `.error.code === 'session/path-not-found'` without any wrapper exception class in between.

## Alternatives considered

**Parse the native opener's own "not found" text per platform.** Rejected: `open`, `xdg-open`, and PowerShell's `Invoke-Item` each report a missing target in their own unstructured text, so parsing it would be brittle and drift with OS locale or platform version; a pre-check answers identically everywhere.

**Skip the pre-check and rely on the opener's own rejection.** Rejected: the opener is a shelled-out platform command with no structured "not found" signal this process can read; a caller would remain unable to distinguish `session/path-not-found` from any other opener failure.

## Consequences

A caller can branch on `error.code === 'session/path-not-found'` to offer a different action than a generic failure — for example, prompting to re-select a file rather than showing a raw platform error. Every open attempt now pays one extra `stat` call; on the existence-check failure path the native opener is never invoked, avoiding a doomed subprocess spawn for a path that will not resolve. `session-open-workspace-path.host.spec.ts` covers the miss/non-ENOENT-fallthrough/abort-during-stat-race cases, and its pre-existing cases now stage a real `mkdtemp`+`writeFile` file or directory rather than a bare literal path, since the existence check is unconditional.

**Retirement.** This patch is a temporary overlay for a capability upstream does not have yet: if upstream distinguishes a does-not-exist path opener failure itself, this patch is retired and the fork adapts to upstream's form.
