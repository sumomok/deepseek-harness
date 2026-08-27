# Agent Note: A distinguishable not-found error from the path opener

Status: implemented

English | [中文](2026-08-27-host-open-target-not-found.zh.md)

## Problem

`openTarget` in `dsh-host-apiproxy` (the shared implementation behind `host.openPath` and the settings-document text-editor handoff) collapsed every opener failure — a path that does not exist, no registered application, denied permission, a missing platform command — into one `internal` RPC error carrying only a free-text message. A caller could not distinguish "this path does not exist" from any other failure without parsing message text, which is not a contract the message ever promised.

## Decision

`openTarget` checks the resolved path with `stat` before invoking the native opener. An `ENOENT` answers the closed RPC error code `not-found` with `{ path }` in `details`; every other `stat` failure (permission, a non-directory path segment, a transient Windows sharing violation) falls through unchanged, and every opener failure still folds into the existing `internal`/`cancelled` handling. The check runs ahead of the opener call because the opener is a shelled-out platform command (`open`, `xdg-open`, PowerShell's `Invoke-Item`), never a Node fs call — it never raises a `NodeJS.ErrnoException` this process could read a reliable code from, and each platform's own "no such file" text is unstructured and unparsed. A pre-check is the only approach that answers the same way on every platform.

Because `stat` is itself an await, a caller's abort landing while it is in flight would otherwise reach the opener already-fired: an opener that only listens for the live `abort` DOM event (rather than also polling `signal.aborted` up front) would then never observe it and the request would hang. `openTarget` re-checks `signal.aborted` immediately after the `stat` pre-check and before invoking the opener, so an abort during the existence check still answers `cancelled`.

`not-found` is a new row in `RpcErrorDetailsMap` and `rpcErrorSchema` (`packages/host/apiproxy/src/api/rpc.ts`, `rpc.schema.ts`), so it flows through the same closed-union validation every other RPC error code does. `WorkspaceRuntime.openPath` (`packages/client/runtime/src/client/workspaces/service.ts`) now throws `PathOpenError` — carrying the Host's `RpcError` as `readonly rpcError` — instead of a bare `Error`, matching the existing `WorkspaceCreateError`/`DirectoryBrowseError` pattern. `PathOpenError`'s message text is unchanged from the `Error` it replaces (`path open failed: ${rpcError.message}`, no code inserted), so the change is additive: a caller reading only `.message` — including the file-open-failure host-refusal dialog, whose exact text a snapshot fixture pins — sees the same string as before, and reading `.rpcError.code` is new.

## Alternatives considered

**Parse the native opener's own "not found" text per platform.** Rejected: `open`, `xdg-open`, and PowerShell's `Invoke-Item` each report a missing target in their own unstructured text, so parsing it would be brittle and drift with OS locale or platform version; a pre-check answers identically everywhere.

**Match `WorkspaceCreateError`/`DirectoryBrowseError` exactly and fold the code into `PathOpenError`'s message.** Rejected: a host-refusal dialog already renders `PathOpenError.message` verbatim, and a snapshot fixture pins that exact text; inserting the code would be a visible, unrequested UI text change for a capability the task asked to add non-breakingly. Carrying `rpcError` as a field is the non-breaking extension a caller needs.

**Skip the pre-check and rely on the opener's own rejection.** Rejected: the opener is a shelled-out platform command with no structured "not found" signal this process can read; a caller would remain unable to distinguish `not-found` from any other opener failure.

## Consequences

A caller can branch on `PathOpenError.rpcError.code === 'not-found'` to offer a different action than a generic failure — for example, prompting to re-select a file rather than showing a raw platform error. Every open attempt now pays one extra `stat` call; on the existence-check failure path the native opener is never invoked, avoiding a doomed subprocess spawn for a path that will not resolve. Several test fixtures across `dsh-host-apiproxy` and `dsh-client-runtime` that previously exercised the opener with a bare literal path now stage a real file or directory, since the existence check is unconditional.

**Retirement.** This patch is a temporary overlay for a capability upstream does not have yet: if upstream distinguishes a does-not-exist path opener failure itself, this patch is retired and the fork adapts to upstream's form.
