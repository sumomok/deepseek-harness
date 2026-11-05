# Agent Note: file references resolve against the current working directory when clicked

Status: implemented

English | [中文](2026-10-22-reference-active-directory.zh.md)

## Problem

The `working_directory` tool changes a Session's effective directory and records it as a `working-directory/change` event, while the immutable Session header keeps the original project directory. The Host lists `@` candidates relative to the current directory (`packages/context/file-reference-local/src/index.ts`, through `workingDirectory.ensure`), and the file tools resolve relative paths against it (`packages/fs/tool-fs/src/session-cwd.ts`). The browser resolved every relative file reference against the header directory instead: the composer chip (`openReference` in `packages/client/ui-reference/src/client/index.ts`), the file node in a sent message (the same file's `conversation.user.text.node` injection), and the Chat `openFile` closure behind Assistant Markdown links, tool rows, and produced-file mentions (`packages/client/ui-chat/src/client/apply.ts`). After the agent entered a subdirectory, a file picked from the `@` menu or linked relatively in a reply opened at the header-relative path, and the preview reported a missing file or showed a different file with the same relative name. The Host resolves a Session-scoped file address against `header.cwd` (the `workspaceFileScope` lookup in `packages/api/workspace-files/src/index.ts`); upstream resolves the same way through `dsh-v0.2.1-rc.2`.

## Decision

**The browser resolves a relative reference at the moment of the click against the Session's current working directory.** The current directory is the `workingDirectory` Session projection (`packages/session/working-directory/src/index.ts`), which the Host sends to the Client through its wire view. The Client reads it with `sessions.binding(sessionId)?.session.projections.faceOf('workingDirectory').getSnapshot()` and narrows the value with `typeof value === 'string'`. When the projection is absent or null — no retained binding, no recorded directory, or a composition without the working-directory service — the header directory from the session list is the base.

**The Sidebar address keeps the header directory as its root.** Each opener computes `target = resolveWorkspacePath(current ?? header, path)` and opens `fileAddressFor(sessionId, header, target)`. A target inside the header workspace receives a Session-relative address (`dsh-resource://file/session/<id>/child/notes.md`), the same address the file tree uses for that file; a target outside it keeps its absolute path, which the Host file read accepts. `ReferentRef.target` carries the same resolved path, so a `referent/open` listener receives the file the default action opens.

**Four call sites resolve this way.** In `ui-reference`, the composer chip's `openReference` and the sent file node's `openFile` injection share `locateFile`. In `ui-chat`, the `openFile` closure keeps `options.line` as the navigation parameter, and `buildProseReferents` passes the current directory as `cwd` to the `ProseReferents` provider's `scan` and `resolveLink`. Each package has its own three-line `currentDirectoryOf`: `dsh-util-workspace-path` has zero dependencies and cannot read `ISessions`, and a shared Client module would add a new file to the fork's core-patch line for three lines of code.

**Model-visible text does not change.** `@` candidates, inserted mention text, and paths in replies keep their spelling, so model requests and recorded-session snapshots are unchanged.

## Alternatives considered

**Resolve on the Host by changing the file scope's base directory.** Rejected: the `workspaceFileScope` lookup's `workspaceRoot` is also the root of the file-tree listing and change watching, so basing it on the current directory would re-root the file tree each time the agent changes directory. Adding a base-directory parameter or a second address scope instead adds Host Remote parameters and address syntax for a resolution that only the click site needs.

**Plugin layer: candidates carry header-relative paths.** Rejected: an `@` row displays and inserts the same `candidate.path` (`fileCandidate` and `onPick` in `ui-reference`, `formatFileMention` in `packages/context/file-reference/src/grammar.ts`), so the inserted text cannot change without changing what the row shows. The inserted mention reaches the model, and the file tools resolve relative paths against the current directory, so a header-relative path names a file the model cannot read.

**Plugin layer: candidates carry absolute paths.** Rejected: it changes model-visible text, and it does not cover relative links in replies, which never pass through `@` candidates, or a mention the user types by hand.

## Consequences

A reference resolves against the directory current at the click, not the directory current when the reference was written. After the agent changes directory again, an earlier relative reference — a sent chip or a reply link — resolves against the new directory. Recovering the directory of each message requires the `working-directory/change` history at that message's sequence number; that work is deferred until a user reports an earlier reference opening the wrong file. Markdown image sources and image-link thumbnails in `ChatView` still resolve against the header directory when rendered: the typed `useProjection` keys in the Client program do not include `workingDirectory`, whose projection-map declaration lives in the Host package, and a render-time base that follows the agent would re-resolve images that already display correctly.

`packages/client/ui-reference/tests/browser-plugin.client.spec.ts` and `packages/client/ui-chat/tests/apply-inject.client.spec.tsx` pin resolution at the click: the header fallback before a directory is recorded and for a null projection, a subdirectory inside the workspace, a directory outside it, absolute paths, `#L` lines, `scan` and `resolveLink`, and Windows drive and backslash spellings. `apps/web/tests/reference-active-directory.e2e.ts` drives the user path through the shipped composition: the agent enters `child/` with `working_directory`, and the composer chip, a relative reply link with a line fragment, and the chip in the sent message each open the `child/` copy of a name that also exists in the workspace root.

The fork records the change as core-patch family `reference-active-directory` in `.claude/core-patches.md`. The family retires when upstream resolves these clicks against the current directory, when the Host file scope stops using only `header.cwd` as its base, or when `FileReferenceCandidate` carries a base directory or an absolute path.
