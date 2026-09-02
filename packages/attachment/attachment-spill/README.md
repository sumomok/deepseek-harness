---
description: "Idempotent, session-scoped spill materialization for oversized text-file attachments — replaces truncated inline attachment text with a locator the model reads on demand."
kind: "package-reference"
---

# @deepseek-ai/dsh-attachment-spill

English | [中文](README.zh.md)

## Summary

`dsh-attachment-spill` keeps an oversized text-file attachment fully readable instead of losing everything past a character cap. It registers `ctx.attachmentSpill`, consumed by `@deepseek-ai/dsh-llm`'s file-lowering path (`lowerFileBlocksFromStore`) through each provider adapter (`dsh-llm-deepseek`, `dsh-llm-pi-ai`). A file whose decoded text exceeds the configured threshold spills to a session-scoped [`ctx.spillStore`](../../spill/spill) artifact reused across every later request build for that (session, attachment) — one stable locator, not a fresh one every step. No configuration is required: the shipped defaults reuse the prior always-truncate cap as the spill threshold, so nothing changes until a deployment tunes it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package in a composition that also mounts a provider adapter with file attachments and a `SpillStore` backend (e.g. `dsh-spill-local`). Each adapter's own `lowerFileBlocksFromStore` call threads `ctx.attachmentSpill` through automatically; no adapter-facing configuration is needed beyond loading the plugin.

### Config

| Key | Default | Meaning |
|---|---|---|
| `inlineWholeUnderChars` | `16000` | Character threshold at/under which a file's decoded text stays fully inline (unchanged from before this package existed). Above it, the file spills. Non-negative integer; validated at load. |
| `previewChars` | `4000` | Characters of a spilled file's decoded text shown as a preview alongside its locator. Non-negative integer; validated at load. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-attachment-spill) is the exhaustive source for every accepted field.

### Behavior

1. `resolveSpill(attachment, content)` reads the CURRENT initiating agent (`ctx.agents.currentInitiator()`) — never a caller-supplied session id — because a request always lowers file blocks from within the initiating agent's own asynchronous chain, and deriving ownership from the live `Agent.session` rules out the two ever disagreeing.
2. No live initiating agent (a session-less LLM call outside any agent turn) ⇒ returns `undefined`; the caller keeps the file inline, truncated. Spilling without a session to log the materialization against would make the model-visible locator text unreconstructable from the session log.
3. A cache hit for (session, attachment id) returns the cached `SpillRef` — no repeated `saveText` call, no repeated `attachment/materialized` record.
4. A cache miss with no `ctx.spillStore` loaded, or a `saveText` rejection, ⇒ returns `undefined` (best-effort; logs a warning). The caller keeps the file inline, truncated.
5. A cache miss that succeeds calls `ctx.spillStore.saveText` with a deterministic, readable `suggestedName` (`attachment-<first 8 hex of the sha256>-<display name>`), appends `attachment/materialized { attachmentId, locator }` to the initiating agent's session, caches the `SpillRef`, and returns it.

**Idempotency is per-process**, not per-session-forever: `@deepseek-ai/dsh-spill-local`'s `saveText` never reuses a path for a repeated `suggestedName` (an unpredictable random prefix guards against symlink planting in a shared root), so there is no deterministic filename to `stat` before writing. A resumed process starts with an empty cache and may spill the same attachment again under a fresh locator — which is itself freshly logged, so the session log always accurately reflects the locator a given request step actually showed the model, even though it does not guarantee ONE spill file per attachment across the attachment's whole lifetime.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the package; the observable behavior is fully covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the `AttachmentSpill` service, the idempotency cache, `fileSpillOptionsFrom` |
| [`src/types.ts`](src/types.ts) | The `attachment/materialized` session event vocabulary |
| — | No runtime invariant companion is published; the idempotency cache and its `attachment/materialized` log record are enforced at the `resolveSpill` call site, and this package owns no other event sequence or mutable relation to observe. |

### Why the current initiator, not a threaded session id

`resolveSpill` runs inside each adapter's own request-construction call, which itself runs inside the initiating agent's asynchronous chain. Reading `ctx.agents.currentInitiator()` there — rather than accepting a session id parameter — makes it structurally impossible for the spill's owner and the agent whose turn is lowering the file to disagree.

### Why a dependency-graph package, not a `dsh-llm` export

`dsh-spill` depends on `dsh-llm` (for `ToolCallId`), so `dsh-llm` cannot depend back on `dsh-spill` without a cycle. `dsh-llm/file-lowering.ts` therefore only declares the shape it needs (`LoweredFileSpillRef`, structurally compatible with `dsh-spill`'s `SpillRef` but not importing it) and accepts a caller-supplied `resolveSpill` hook. This package sits above all four packages in the dependency graph and is the one place that wires the concrete `SpillRef`-returning implementation through that hook.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Attachment storage seam](../attachment/README.md) — the durable `FileAttachmentRef`/`AttachmentStore` vocabulary this package spills text read through.
- [Spill storage service](../../spill/spill/README.md) — the `saveText` contract and vocabulary the backend this package calls implements.
- [dsh-spill-local](../../spill/spill-local/README.md) — the filesystem backend most compositions mount as `ctx.spillStore`.
- [Attachment subsystem](../../../docs/subsystems/attachment.md) — the exhaustive vocabulary and ownership.

-----

<a id="model-experience"></a>
## Model Experience

### An oversized file attachment

#### What the model sees

A file at or under `inlineWholeUnderChars` characters is unchanged (full inline text, as before). A larger file with a resolvable spill artifact becomes a header line — `File <name> (<size>, <N> chars) stored at: <locator>. <retrievalHint>` — followed by a fenced block holding only the first `previewChars` characters and a trailing `(preview: first <shown> of <N> chars)` note; the exact rendering is `@deepseek-ai/dsh-llm`'s `lowerSpilledFileBlockText`. A larger file with no resolvable spill artifact (no owning session, no backend, or a storage failure) falls back to the previous truncated-inline format instead.

#### Token effect

A spilled file costs its header line plus `previewChars` characters, once per request build, regardless of the file's real size; the full text is read only when the model calls `read`/`grep` on the locator.

#### KV Cache effect

A repeated request build reuses the SAME locator for an unchanged attachment within one process (the idempotency cache), so the lowered text is byte-identical across steps and does not itself invalidate the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Idempotency does not survive a process restart** — see [Behavior](#use-this-package) above; a resumed session may re-spill an already-spilled attachment under a fresh locator rather than reusing the original file.
- **No initiating agent ⇒ no spill, ever** — a session-less LLM call (e.g. a direct one-shot request outside any agent turn) always falls back to truncated inline text for an oversized file, even when `ctx.spillStore` is loaded.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions. It is explicitly non-authoritative.

#### Future: cross-process idempotency

The in-process `Map<SessionId, Map<AttachmentId, SpillRef>>` cache is a deliberate, documented limitation, not a promise: a backend that supports lookup-by-suggested-name or content-addressed deduplication (unlike `dsh-spill-local`'s always-fresh-random-path writes) could let a resumed process rediscover an already-spilled artifact instead of re-spilling it.

</details>
