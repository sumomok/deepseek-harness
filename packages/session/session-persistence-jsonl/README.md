---
description: "The shipped JSONL session-persistence backend for deployments and maintainers choosing, configuring, or debugging per-session durable logs with optional Zstandard compression."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-jsonl

English | [中文](README.zh.md)

## Summary

`dsh-session-persistence-jsonl` stores each session in a current append-only JSONL log and retains immutable historical format generations — checksummed Zstandard frames by default, raw newline-delimited lines when compression is disabled. It serves the current logical `SessionEvent` stream through persistence handles, so format migration, compression, historical decoding, and crash recovery remain storage-internal details. Choose it when consumers need a per-session file on disk; the logs are readable as plain lines when `compression: 'none'` is selected. A root directory is the one required configuration; durability, lazy materialization, [supported historical-format migration](../session-format-catalog/README.md), and torn-tail crash recovery come with the backend.

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

Mount this backend when a composition needs durable sessions backed by per-session files. The common path is explicit: load the session service, mount the backend, and give it a root directory.

### When to choose it

Choose this backend when consumers benefit from one artifact per session — navigation, external tooling, or a raw line-readable log. It is the sole first-party Session-persistence provider. The backend keeps sessions under a deployment-controlled root: project-local, shared, temporary, or centralized.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: /absolute/path/to/session-logs
```

`root` is required and has no default: a `process.cwd()` default would scatter session files as the process's cwd changes. An existing root must be a readable directory; an absent root is created on first materialization.

| Field | Default | Meaning |
|---|---|---|
| `root` | required | Root directory for all session files |
| `compression` | `'zstd'` | Physical encoding: `'zstd'` checksummed frames, or `'none'` newline-delimited UTF-8 text |

Live-event write batching is not configuration: the batching window is the seam's internal scheduling policy inside each write handle.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-jsonl) is the exhaustive source for every accepted field and its JSDoc.

### On-disk layout

Each session gets a session-owned directory under a readable project directory. Every canonical generation starts with a physical header whose version equals its filename. The current format stores one physical row per durable event; the frozen v0 and v1 readers also understand their historical packed Assistant-delta rows. The current format stores `isSeeded` in the header and derives the inherited cut from the last tagged `session/end-seed` marker, while historical codecs translate their numeric `seedLength`. The format catalog completes that translation before a handle exposes current logical values. Current storage records use the lossless source-event representation described below:

```text
<root>/
  .relocate.<sha256-of-id>.json  # relocation in progress; removed once it settles
  .relocate.<sha256-of-id>.json.<token>.tmp  # unpublished intent; the next relocation of that session removes it
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.jsonl.zstd         # released v0, compressed root
      session.v1.jsonl.zstd      # released v1, compressed root
      session.v2.jsonl.zstd      # released v2, compressed root
      session.v3.jsonl.zstd      # released v3/current, compressed root
      session.jsonl              # released v0, raw root
      session.v1.jsonl           # released v1, raw root
      session.v2.jsonl           # released v2, raw root
      session.v3.jsonl           # released v3/current, raw root; later versions use vN
```

Session ids are injectively escaped to one safe path segment before use (no traversal, no collision). The normalized cwd keeps the project directory readable for navigation; cwd strings that normalize alike share a project directory while session ids still select distinct session directories. Runtime operations select the numerically highest canonical generation, and format-refusal diagnostics name that absolute path so an operator can find the raw log a build refused to interpret.

### Durability and crash semantics

A session is materialized lazily: `create(header)` writes nothing and returns the owned write handle, and the handle's first `append` writes and `fsync`s the encoded header and first batch through a no-overwrite publish — so a created-but-never-appended session leaves nothing on disk unless its owner calls `handle.flush()`, which publishes one header frame without an event. Each subsequent batch appends lines or one compressed frame and `fsync`s before the append resolves; a caught write or sync failure rolls the file back to its prior length. Committed events are never rewritten. Relocation re-encodes only the current header record; the event records below it keep their bytes, except complete records recovered from a torn tail, which it re-encodes the way the write path does. After a crash, the stored log keeps its interrupted final turn — every record in the committed prefix survives, and the resuming reader appends synthetic closers through its write handle. An incomplete final raw line is discarded. A torn final Zstandard frame contributes only its complete decoded JSONL records; a write handle truncates the torn bytes and durably rewrites those recovered records before its first new batch. Checksum, decompression, or structural failure in a complete committed frame rejects as corruption.

The current-generation scanner applies the current codec owner’s structural admission checks before recoverable-tail handling. Retired required PTC tags and `request/header.header.system` refuse the file even after an earlier malformed row; recovery never truncates them as ordinary damaged tail data.

### Reading the logs

`open(id, 'read'|'write')` selects the highest canonical generation. Current input follows the ordinary fast path. For historical input, a read open decodes and migrates the source once, validates the current logical result, and returns it without publishing a successor. A write open reuses that revision-keyed preparation when available, or performs the same preparation, then encodes a same-directory temporary file in bounded chunks, verifies it in a Worker Thread, rechecks the source revision, and publishes the current successor without overwrite before returning. The source remains byte-identical. Source drift after preparation rejects that write open without replacing the logical history already returned to readers; a later write open prepares the new revision. The backend marks decoded event graphs `shared-frozen` when it freezes them before memoization; every nested object and array is frozen, and handle reads and slices preserve that state, including empty slices. Only an unmaterialized pending log reports `detached`. `stat(id)` and `list()` select and translate only the highest generation header without reading event rows or starting migration; snapshots carry the selected file’s `sizeBytes` and a best-effort revision. Current revisions identify that file; historical revisions also fingerprint the selected files across the persistence root, so child changes invalidate cached logical events. Fingerprinting reads filesystem metadata only; unrelated changes conservatively invalidate historical revisions. One `list()` call shares a corpus fingerprint across its historical entries. With `compression: 'none'`, the log is newline-delimited text an external reader can consume directly; the compressed default must be read through the backend.

Historical body preparation completes the parent catalog through [V3→V4](../session-format-v3-to-v4/README.md). It finds candidate direct children from headers, reads each child's own descriptor through historical codecs, and retains compact evidence plus source revisions. It neither prepares child catalogs nor publishes child successors. Unreadable or unsupported headers, including corrupt Zstandard header frames, are omitted from discovery and `list()`. Direct access to a corrupt compressed header still rejects; header I/O and cancellation errors propagate. Child decoding and descriptor-field failures produce warnings naming the child path and retain header identity through `subagent/catalog` when the parent has no complete entry; healthy children and existing parent catalog entries remain available. Opening a damaged child still reports that child's error. Missing, unsupported, or multiple descriptors likewise produce unknown-mode membership without inventing a label. Published unknown entries remain browsable; child history reads retry the actual log and resolve its mode from a valid descriptor. Preparation rechecks membership and inspected source revisions before returning, reuse, and publication, including failed child reads so a repaired child invalidates stale preparation. Source drift retries a read open once and refuses a write open. Cancellation still aborts the operation. Current V4 opens bypass discovery and validate catalog fields, uniqueness, and current delivery ownership before exposing events.

Historical `stat` and `list` revisions require metadata work proportional to the root’s Session count. Fresh body preparation scans all selected headers and decodes direct-child bodies; memo reuse still scans membership and checks revisions. Read-only access never publishes an upgrade, so cold processes and evicted preparations repeat that work. Current V4 body reads and revisions avoid the historical corpus scan. See the [measured costs and diagnostic command](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md#catalog-scan-measurements).

<a id="relocating-a-session"></a>
### Relocating a session

`relocate(id, cwd)` moves a stored session to `sessionDir(root, cwd, id)` and replaces its header cwd. It takes the in-process write claim and the write locks of the source and target directories, so a writer in any process refuses it with `SessionAlreadyOwnedError`, while read handles stay open. A historical session first gets its current successor, published exactly as a write open publishes it. The backend then writes the rewritten current generation beside its destination — the new header record followed by the source's committed bytes after the old header and any records recovered from a torn tail — and verifies it in a Worker Thread. Retained prior generations move into the target directory under hidden names, the source current generation is hidden, and publishing the new current generation is the commit point; the prior generations then regain their names and the source directory is removed, except that a directory holding unrecognized files stays and is reported. A source and target on different filesystems, or a target that already holds a stored log, refuse the move before any session file moves; the refusal removes the target session directory the move created, while a target project directory it created stays. A target cwd whose normalized project directory equals the source's rewrites the current generation in place.

Unless another writer stores a session with the same id meanwhile (see below), every step keeps two facts for every reader, including builds without relocation support: at most one directory holds canonical generations of the session, and the highest one's header cwd names that directory. Between hiding the source and publishing the target the session is absent: `stat` reports no session, `list` omits it, and `open` rejects with `SessionPersistenceNotFoundError`. An `open` or handle read that located the source just before it was hidden rejects with the filesystem's `ENOENT` error, as in builds without relocation support when a log vanishes. A root-level `.relocate.<sha256>.json` intent names both directories until the move settles. The backend's first operation recovers every intent a dead process left: it rolls the move back while the target current generation is absent and completes it when that generation continues the moved log: it begins with the staged copy while one exists, and otherwise its header record matches the hidden source current generation's in every field but cwd and its bytes after the header begin with that generation's committed bytes (the length the intent records) after the header; an intent that contradicts the storage, or whose directory another holder keeps, stays and is reported. Recovery emits no event. A successful move emits `session-persistence/relocated` after releasing its locks.

A move that dies between hiding the source and publishing the target leaves the session absent until a backend recovers it: at a process's first operation, or when a relocation of that session settles the intent. A process that already ran its recovery keeps seeing the session absent, and a caller that treats an absent session as new — Session Controller's adopt and the agent loop's configured-session start both do — stores a new session with the same id. Before publishing the target or restoring a hidden source, the backend therefore searches every other project directory for a canonical generation of the id; recovery also recognizes a new session at the target, whose current generation does not continue the moved log, and one at the source, which restoring the hidden source would replace. In each case the move stops with its intent and hidden files in place, a warning names the intent, and relocating the id rejects with `SessionPersistenceCorruptionError` naming the intent. An intent temporary left by a process that died while writing its intent stays until the next relocation of that session removes it.

A stopped move keeps the original session under non-canonical names, where `<token>` is the intent's `token` field: the source session directory holds its current generation as `session.v4.jsonl[.zstd].relocating-<token>`, and the target session directory holds each prior generation `<name>` as `<name>.relocating-<token>` and the staged rewrite as `session.v4.jsonl[.zstd].relocate-<token>.tmp`. Keep these files and the intent: the hidden current generation and the stage each hold every event (the stage under the new header), the hidden prior generations exist nowhere else, and once the intent is gone nothing restores the hidden files, which stay behind without a warning. To restore the original session, delete the new session's generation file — `session.v4.jsonl[.zstd]` with no further suffix, in `sessionDir(root, cwd, id)` for the cwd `list()` reports — or move it out of the root to keep its content, then restart the process or relocate the id; recovery rolls the move back and the original session returns byte-for-byte. When the new session is in the target directory, remove only that file, not the directory, which also holds the hidden prior generations.

Relocation removes the source directory together with the lock file it holds, so a write open resolves the session again after locking; when the session moved meanwhile, the open discards the directory it recreated and retries once.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the physical encoding and write path; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The backend owns its complete storage runtime (`src/storage.ts`): `JsonlSessionHandle` carries the per-handle mutation chain, the routed live-event buffer with its fixed batching window and single-flight drain, monotonic reads, and idempotent close; a tracker holds the in-process single-writer claims, the open-handle set teardown sweeps, and the created-but-unmaterialized pending sessions the backend's own session listeners route into. Historical body reads share one per-session Decode/Migrate preparation, and a bounded revision-keyed memo lets an immediate observe-to-resume handoff reuse that parse; the backend deep-freezes each event graph once before memoization, so later handle reads reuse it without copying or freezing. Only a write open publishes the prepared successor. The package deliberately exposes only its default plugin export plus configuration types — the concrete class is not a named export, so consumers couple to `ctx.sessionPersistence`, and the shared seam suites (`runPersistenceContract`/`runLiveWritePathContract`) pin its observable behavior. Physical revisions combine device, inode, size, and nanosecond timestamps for the preparation memo, stable-read retries, and publication checks. Historical public revisions add a SHA-256 fingerprint of sorted selected paths and their physical revisions; lock files and retained unselected generations do not contribute.

### Physical encoding

The default artifact is a standard concatenation of independent Zstandard frames: one checksummed frame containing only the header line, then one checksummed frame per durable append batch, using Node's built-in Zstandard API at its default compression level (no level knob). The current format writes one event per row; `sourceEventSeqs` uses a lossless storage representation in which consecutive runs of at least three sequence numbers become `[start, end]` pairs, any other list stays verbatim, and reading expands the exact in-memory array. Historical migration reuses one Zstandard decoder, passes parsed rows through stateful format stages, and streams current records through one compression context in about 1 MiB main-thread slices while retaining only final current events, bounded decoder state, and the required sequence-remap table. Listing reads and validates only the header frame. `compression: 'none'` keeps the same storage-form logical lines without frame compression. A root belongs to one encoding: startup discovery and targeted lookup reject generations with the other suffix; format migration preserves the configured encoding, while compression conversion, mixed-root fallback, and dual write remain unsupported. Frozen v0 and v1 codecs retain their packed-row decoders solely for historical generations.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, the backend service class, and file storage primitives |
| [`src/storage.ts`](src/storage.ts) | The JSONL handle, routed live-event buffer, in-process writer bookkeeping, listeners, teardown |
| [`src/format.ts`](src/format.ts) | Log path derivation, header encoding, and current record scanning |
| [`src/generation.ts`](src/generation.ts) | Single-pass historical restore, bounded stage encoding, source revision check, and exclusive successor publication |
| [`src/migration-verifier.ts`](src/migration-verifier.ts) | Worker lifecycle for staged and competing-generation verification |
| [`src/zstd.ts`](src/zstd.ts) | Zstandard frame compression, decoding, and frame scanning |
| [`src/relocation.ts`](src/relocation.ts) | Relocation steps, intent records, and crash recovery |
| [`src/win32.ts`](src/win32.ts) | Windows write-through publish, in-place replacement, and directory creation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared persistence model to the sibling backend and the physical-format decisions.

- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — backend-neutral service semantics and provider relationships.
- [Session persistence seam](../session-persistence/README.md) — the service contract this backend implements.
- [Released Session format migrations](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) — immutable generations, adjacent migration edges, and publication rules.

-----

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

JSONL storage contributes no live prompt or schema. Loading restores stored surface history and preserves prior request headers for reconstruction; the new loop composes its current envelope. Recovery balances an assistant request without a durable call with `TOOL_NOT_STARTED`; a durable call without a result becomes `TOOL_OUTCOME_UNKNOWN`, which tells the model to retry only read-only or idempotent work and to verify possible side effects or ask the user. Embedded Assistant streams and log-only attempts do not duplicate messages.

#### Token effect

Zero live-request tokens. A resumed agent pays for retained history and its current envelope, plus the quoted repair result for each interrupted call.

#### KV Cache effect

JSONL storage does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Format migration preserves the configured encoding and supports only the catalogued chain** — this build migrates supported historical generations to the current format; changing compression requires a separate root, and retained predecessors do not provide automatic fallback or downgrade support.
- **The flat-file storage layout does not load** — use a separate root or move pre-release artifacts into the project/session directory layout before loading.
- **Compressed files are not directly line-readable** — use the backend to load them, or select `compression: 'none'` before writing a fresh root when external line readers are required.
- **Nothing deletes session files except relocation's removal of the source copy after the target is durable** — logs accumulate under `root` until removed externally; the seam has no deletion API.
- **Relocated prior generations keep their old header cwd** — they stay unread while the current generation exists; deleting the current generation by hand selects a prior one whose header names another directory, and listing the root then fails. A relocation briefly needs twice the session's space.
- **A create that finds a relocating session absent can still store a second copy** — `create` checks the id when called and stores at its first append. A create that saw the session absent and first appends after the backend's search for same-id sessions, which precedes publishing the target or restoring the source, leaves the id in two directories, and listing the root then fails, as when two processes create one id under different cwds.
- **One live writer per session** — the write-handle claim excludes a second writer inside the owning backend instance, and a kernel lock (non-blocking `flock(2)` on `session.lock`; on Windows a named kernel semaphore derived from that path, with no filesystem footprint) excludes every other instance and process; the lock is taken at write-open of an existing artifact and, for a created session, only right before its first materializing write, so an unmaterialized session leaves no filesystem footprint. A crashed holder's lock dies with its process, so its session is writable again immediately, while a live-but-wedged holder blocks writers until its process exits (on POSIX, removing the lock file forfeits that exclusion; release itself never removes it, and relocation removes only a lock file it holds). After a relocation, that exclusion also requires every process that writes the root to run a build that resolves the session again after locking: a build without that check can lock a directory the relocation removed and append beside the writer at the new location. Advisory `flock` is unreliable on some network filesystems (NFSv3), and the Windows semaphore name is per login session.
- **POSIX materialization requires hard-link support** — first append uses `link()` so same-id races fail instead of overwriting a committed log; Windows uses write-through rename without replacement.
- **POSIX writes require the matching prebuilt system addon** — [`node-addon-system`](../../../native/system/README.md) supplies asynchronous flock without consumer-side compilation. A missing addon rejects write ownership; Windows retains its semaphore implementation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
