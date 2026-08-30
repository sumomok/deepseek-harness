# @deepseek-ai/dsh-attachment-spill

English | [中文](README.zh.md)

Idempotent, session-scoped spill materialization for oversized text-file attachments. Registers `ctx.attachmentSpill`, consumed by `@deepseek-ai/dsh-llm`'s file-lowering path (`lowerFileBlocksFromStore`) through each provider adapter (`dsh-llm-deepseek`, `dsh-llm-pi-ai`).

A provider adapter re-lowers every `file` content block in the complete message history on every request build. A file whose decoded text exceeds `inlineWholeUnderChars` therefore needs one STABLE spill artifact reused across every later request build for that (session, attachment), not a fresh one — and a fresh locator — every step. This package owns exactly that: given a `FileAttachmentRef` and its already-decoded text, `resolveSpill` resolves or creates the backing [`ctx.spillStore`](../../spill/spill) artifact, caches the result in-process, and appends `attachment/materialized` the first time in this process it spills a given attachment — the durable record that keeps the model-visible locator text reconstructable from the session log.

`fileSpillOptionsFrom(attachmentSpill)` adapts a resolved `AttachmentSpill` instance into `@deepseek-ai/dsh-llm`'s `FileSpillOptions` for a provider adapter's own `lowerFileBlocksFromStore(messages, attachments, signal, fileSpillOptionsFrom(ctx.get('attachmentSpill')))` call — the one conversion both `dsh-llm-deepseek` and `dsh-llm-pi-ai` share.

## Config

| Key | Default | Meaning |
|---|---|---|
| `inlineWholeUnderChars` | `16000` | Character threshold at/under which a file's decoded text stays fully inline (unchanged from before this package existed). Above it, the file spills. Non-negative integer; validated at load. |
| `previewChars` | `4000` | Characters of a spilled file's decoded text shown as a preview alongside its locator. Non-negative integer; validated at load. |

## Behavior

1. `resolveSpill(attachment, content)` reads the CURRENT initiating agent (`ctx.agents.currentInitiator()`) — never a caller-supplied session id — because a request always lowers file blocks from within the initiating agent's own asynchronous chain, and deriving ownership from the live `Agent.session` rules out the two ever disagreeing.
2. No live initiating agent (a session-less LLM call outside any agent turn) ⇒ returns `undefined`; the caller keeps the file inline, truncated. Spilling without a session to log the materialization against would make the model-visible locator text unreconstructable from the session log.
3. A cache hit for (session, attachment id) returns the cached `SpillRef` — no repeated `saveText` call, no repeated `attachment/materialized` record.
4. A cache miss with no `ctx.spillStore` loaded, or a `saveText` rejection, ⇒ returns `undefined` (best-effort; logs a warning). The caller keeps the file inline, truncated.
5. A cache miss that succeeds calls `ctx.spillStore.saveText` with a deterministic, readable `suggestedName` (`attachment-<first 8 hex of the sha256>-<display name>`), appends `attachment/materialized { attachmentId, locator }` to the initiating agent's session, caches the `SpillRef`, and returns it.

**Idempotency is per-process**, not per-session-forever: `@deepseek-ai/dsh-spill-local`'s `saveText` never reuses a path for a repeated `suggestedName` (an unpredictable random prefix guards against symlink planting in a shared root), so there is no deterministic filename to `stat` before writing. A resumed process starts with an empty cache and may spill the same attachment again under a fresh locator — which is itself freshly logged, so the session log always accurately reflects the locator a given request step actually showed the model, even though it does not guarantee ONE spill file per attachment across the attachment's whole lifetime.

## Model Experience

### An oversized file attachment

#### What the model sees

A file at or under `inlineWholeUnderChars` characters is unchanged (full inline text, as before). A larger file with a resolvable spill artifact becomes a header line — `File <name> (<size>, <N> chars) stored at: <locator>. <retrievalHint>` — followed by a fenced block holding only the first `previewChars` characters and a trailing `(preview: first <shown> of <N> chars)` note; the exact rendering is `@deepseek-ai/dsh-llm`'s `lowerSpilledFileBlockText`. A larger file with no resolvable spill artifact (no owning session, no backend, or a storage failure) falls back to the previous truncated-inline format instead.

#### Token effect

A spilled file costs its header line plus `previewChars` characters, once per request build, regardless of the file's real size; the full text is read only when the model calls `read`/`grep` on the locator.

#### KV Cache effect

A repeated request build reuses the SAME locator for an unchanged attachment within one process (the idempotency cache), so the lowered text is byte-identical across steps and does not itself invalidate the reusable request prefix.

## Known Limitations and Deferred Work

- **Idempotency does not survive a process restart** — see Behavior above; a resumed session may re-spill an already-spilled attachment under a fresh locator rather than reusing the original file.
- **No initiating agent ⇒ no spill, ever** — a session-less LLM call (e.g. a direct one-shot request outside any agent turn) always falls back to truncated inline text for an oversized file, even when `ctx.spillStore` is loaded.
