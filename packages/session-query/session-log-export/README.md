---
description: "Web Session-log ZIP export: Host streaming, the authenticated download route, the Session Header action, and the /export command."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-export

English | [中文](README.zh.md)

## Summary

`dsh-session-log-export` lets the Web interface download a session's full history: a `Session log` button in the Session Header and an `/export` slash command both hand the session tree — the session, its sub-sessions, and attachments — to the browser as a ZIP download. The package owns the Host archive stream, its authenticated Fetch route, and the browser controls and feedback. The page reads the archive itself and shows how far it has come, so an export's advance and any mid-transfer failure are visible without a browser download manager; the browser still chooses where the finished archive lands. Setup and usage come first; implementation details follow.

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

Use this package when the Web bundle should let users export a session log. It requires Connection, the command registry, Session query and persistence, and attachments. Mount the plugin, then click `Session log` in the Session Header or type `/export`; the browser downloads `dsh-session-<id>.zip`.

### When to choose it

Choose it for a Web deployment that needs user-facing session export with a visible download dialog. Avoid it when a programmatic or Host-side export is needed: this package produces a browser download, not a Host path write. The logs are serialized from persistence read handles, so any mounted backend is supported.

### Composition

```yaml
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

The Web bundle mounts the package with Connection, `dsh-commands`, `dsh-client-ui-commands`, and `dsh-client-ui-conversation`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `compressionLevel` | `6` | DEFLATE level from 0 through 9 for each ZIP entry. |

### Command contract

| Input | Result |
|---|---|
| `/export` | Records a human-command lifecycle; the submitting browser downloads `GET /api/session.export?sessionId=<id>&includeDescendants=true` |
| `/export <path>` | An error; browser downloads choose their destination through the browser's ordinary download behavior |

### Route response fields

| Field | Meaning |
|---|---|
| `Content-Disposition` | `attachment` with the archive filename, `dsh-session-<id>.zip`. |
| `X-Session-Export-Entries` | ZIP entries the archive holds: one per included session log, one per referenced media object. |
| `X-Session-Export-Bytes` | Summed uncompressed size of those entries. |
| `X-Session-Export-Estimated-Wire-Bytes` | Estimated size of the response body, which the browser scales its progress bar by. |

`GET` and `HEAD` answer with the same fields. All three are absent when the archive could not be measured before streaming. The browser needs the entry count and the wire estimate to scale its bar and shows an indeterminate one without either; `X-Session-Export-Bytes` is diagnostic, and a response carrying everything but that still drives a determinate bar.

The wire estimate is the uncompressed total when `compressionLevel` is `0`, because the archive then stores rather than deflates; it still reads slightly low there, by the ZIP framing it ignores — tens of bytes per entry, about 6% of a small archive. Above `0` it applies a calibrated ratio — 0.14, from real exports of session logs, which land between 0.13 and 0.15 — to the log entries and takes media at face value, since PNG and JPEG do not deflate further; ZIP framing, tens of bytes per entry, is ignored. So the bar is honest but not exact: an archive that compresses harder than the calibration reaches 99% before the stream ends and waits there, and one that compresses softer completes from around four fifths.

### What to expect

The panel reports three phases: exporting, complete, or failed. While it exports it shows a progress bar over the bytes received. The bar is determinate whenever the route announced the archive's extent, including for the single-entry archive a session with no sub-sessions and no attachments produces; it is indeterminate only when the route announced none. `Cancel` abandons the transfer and saves nothing; closing the panel leaves the transfer running and still saves the archive, and the panel does not reopen when that operation later settles. One session admits one active download at a time; repeated gestures share that operation. The export includes the live session's newest events: the host endpoint flushes a live root session before reading, so a slash-triggered ZIP includes the `command/run` and `command/done` pair that started the download; cold persisted sessions need no flush. Each logical log uses the current generation's canonical filename inside the archive (`session.jsonl` for v0, otherwise `session.vN.jsonl`), including beneath each sub-session directory. Images use `media/<attachmentId>.<ext>`, and generic files use `files/<digest-prefix>/<digest>/<name>`. Generic-file bytes are read and compressed as bounded chunks, so exporting a large upload does not buffer it in full.

### Failures

The panel names every failure, because the page holds the transfer from the first byte to the last: the HTTP status and the host's message when the route refuses the request before streaming, and the browser's transport error when the connection fails or when a descendant log read tears the archive mid-stream. A host cannot describe a failure that happens after its response has begun — a torn archive reaches the page as `network error` — so the panel reports that the export tore, not why. A failed export saves nothing.

An image the attachment store cannot produce is not one of those failures. The archive carries `media/<attachmentId>.<ext>.error.txt` in place of that one image, naming the reference the log holds — attachment id, media type, byte length, pixel dimensions — plus the store's failure code and reason when it raised an `AttachmentError`; a failure of any other kind is recorded without its own text, which carries no promise to omit host paths. Every other file in the archive is complete and the download succeeds, so a reference written with the wrong media type, or an object deleted or rewritten underneath the store, costs that image and not the export.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package wires the export control and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design split

The package has two halves. The Host half ([`src/index.ts`](src/index.ts)) registers the `/export` command and contributes the exact `GET`/`HEAD /api/session.export` Fetch route to Connection; [`src/archive.ts`](src/archive.ts) builds the bounded ZIP stream. The browser half ([`src/client/index.ts`](src/client/index.ts)) provides the shared download controller and UI, and observes `command/executed` so only the submitting browser starts a download.

### Download flow

Both entry paths `GET /api/session.export?...` through `fetch` and read the response body chunk by chunk. [`src/client/progress.ts`](src/client/progress.ts) turns the received bytes and the ZIP local file header signatures inside them into one fraction — the larger of two lower bounds, held below 1 until the stream ends. Received bytes are scaled by the announced wire estimate, which is what carries a single-entry archive; the entry count raises that off its floor for an archive that compresses harder than the calibration, and an entry counts as finished only once the next entry's header arrives, because a header precedes its own data. Progress reaches the panel once per animation frame rather than once per chunk. The controller then assembles the chunks into a `Blob` and clicks a detached download anchor at its object URL. One controller owns one in-flight download per session, collapses concurrent gestures into that operation, and aborts the transfer on cancellation and on plugin disposal. Panel state lives in a snapshot store keyed by session, so the button and the command share one panel per session.

Before the first archive byte, the Host walks the export once to count its entries and sum their uncompressed sizes — log sizes from the text the stream will push, media sizes from each reference's recorded byte length, which is also what an image the stream turns out to be unable to read is counted at — and answers with those totals. The measuring pass and the streaming pass run the same traversal at two different moments, so measuring re-reads each descendant log (it never re-reads a stored image) and a live sub-session that appends events between them makes the announced totals read low. A measurement failure only drops the three extent fields, because the streaming pass reaches that same failure and owns the outcome.

The Host route is a feature-owned exact Fetch contribution. Connection applies its Host/Origin and browser-session checks and bridges the streaming `Response`; this package owns query validation, live-session flushes, handle-based log reads and attachment reads, ZIP generation, and HTTP status semantics.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the Web control to the host endpoint and the surrounding command and session surfaces.

- [dsh-client-connection](../../client/connection/README.md) — the authenticated Fetch-route carrier used by the Host endpoint.
- [Commands subsystem reference](../../../docs/subsystems/commands.md) — the human-command registry the `/export` command registers on.
- [dsh-client-ui-commands](../../client/ui-commands/README.md) — the browser command surface that renders and acknowledges `/export`.
- [Session Query package map](../README.md) — the retrieval family this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/export` control

#### What the model sees

Nothing. `/export` stays on the human-command plane, and the ZIP download does not enter model history.

#### Token effect

Zero. The command creates no model turn.

#### KV Cache effect

None. The log-only command lifecycle and browser download do not change the derived request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Browser download, not a Host-path writer** — the browser chooses the local destination; no Host path or native folder action is returned.
- **The whole archive is held in memory before it is saved** — the page assembles every received chunk into one `Blob`, which briefly costs twice the archive's size while the chunk list and the `Blob` coexist, so an export is bounded by the tab's memory rather than by free disk space. Session archives are megabyte-scale in practice; a multi-gigabyte tree is out of reach.
- **A foreseeable tear costs the progress bar too** — a descendant the measuring pass also fails to read drops all three extent fields, so the bar is indeterminate from its first frame and the transfer still tears later.
- **A mid-stream failure has no host-authored reason** — the archive's status and headers are already sent when a descendant log read fails, so the page can only report the browser's transport error. The host log carries the real cause.
- **An unreadable image is still announced at its recorded size** — measuring never opens a stored object, so an entry the stream turns out to record rather than carry is counted at the reference's byte length. The entry count stays exact; the two size fields read high by that image's size, so the page divides its received bytes by a wire estimate larger than the body it gets. The bar therefore advances more slowly than the transfer does and jumps to complete from wherever it had reached — the same direction as an archive that compresses more softly than the calibration.
- **The first byte waits for the measurement** — the route walks the whole export before it answers, so time-to-first-byte grows with the number of sub-sessions. A session with none costs one extra lineage call and no extra log read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked pages.

#### Future: export destinations beyond the browser

The download is deliberately browser-scoped; a Host-path or native folder export would need a new endpoint contract and a decision on where the ZIP lands.

</details>

**Runtime invariant:** No companion is published. Connection and the command registry own both registrations, while each export reads authoritative Session services.
