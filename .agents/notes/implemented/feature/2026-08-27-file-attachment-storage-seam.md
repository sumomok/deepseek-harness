# Agent Note: A text-file kind for the durable attachment seam

Status: implemented

English | [中文](2026-08-27-file-attachment-storage-seam.zh.md)

## Problem

Today a file dropped in the composer is either rejected outright — the stock harness has no non-image attachment path — or, through the third-party `@sumomok/dsh-text-drop` plugin being retired, spliced as raw text directly into the draft. Splicing bypasses the durable, content-addressed attachment seam images already use: a session log holding spliced text carries no reference to re-fetch, verify, or dedupe, and the file competes for context budget as ordinary draft text rather than a first-class part with its own limits. This is the first commit of a series that restores first-class file support by mirroring the existing image attachment pipeline exactly.

## Decision

`packages/attachment` gains a `FileAttachmentLimits`/`FileAttachmentRef`/`SaveFileAttachment`/`StoredFileAttachment`/`EncodedFileAttachment` type family parallel to the image family, plus `AttachmentStore.validateFile`/`saveFile`/`saveFiles`/`readFile` (mirroring `validateImage`/`saveImage`/`saveImages`/`readImage`, including the validate-all-then-commit batch discipline) and `admitEncodedFiles` (mirroring `admitEncodedImages`). Two differences from images are deliberate, not oversights: a `FileAttachmentRef.name` is always present (a file card has nothing else to show, unlike an image's optional name), and there is no media type, width, height, or request-projection method (`readImageRequest`'s equivalent) — a file lowers to plain text at request time (a later commit) instead of needing a provider-specific derived form.

`EncodedFileAttachment`'s wire form carries plain UTF-8 text, not base64: unlike a raster, there is no binary transport ambiguity to canonicalize. `admitEncodedFiles` re-encodes that text to bytes so `saveFiles` validates every upload at the byte level regardless of transport, symmetric with how `admitEncodedImages` decodes base64 to bytes before its own batch admission.

`packages/attachment/attachment-local` implements the concrete validation. `sniff.ts` ports the retired plugin's `core/sniff.ts` verbatim (`PROBE_BYTES`, `sniffProbe`, and its test suite): a NUL byte anywhere is conclusive, otherwise a `stream: true` UTF-8 decode tolerates a multi-byte sequence split at the probe's edge. `text.ts`'s `detectText` calls it once over the complete submitted bytes as a fast first-pass classifier, then runs one non-streaming `TextDecoder` pass to authoritatively catch the one case `stream: true` is built to tolerate — a genuinely truncated sequence at the very end of a complete file. Both failures raise `NOT_TEXT_FILE`. Unlike images, a text file is stored unchanged: no normalization, no derived request form. The durable object is the exact submitted bytes, content-addressed by their own SHA-256 digest, sharing the same `objects/` tree images already populate — both attachment kinds are digest-keyed blobs, so the storage layer needed no new concept for the new kind. The publish (`commitPreparedTextFile`) and read (`readTextFile`) paths share their durable-write and digest-verified-read cores with images (`commitDurableObject`, `readVerifiedObject`) through an extraction this change makes, rather than duplicating the fsync/hardlink/verify dance a second time.

## Alternatives considered

**Give files their own object namespace, separate from images.** Rejected: both kinds are immutable, digest-addressed blobs; splitting them would need a reason neither kind's read or write path has, and existing image objects would need no equivalent split.

**Have the seam accept `SaveFileAttachment.data` as a JS string instead of bytes.** Rejected: the abstract seam already accepts raw bytes for images regardless of wire encoding, so accepting bytes for files keeps one validation entry point that behaves the same whether the caller is the wire admission path, a future CLI, or a test — and it is the only way `NOT_TEXT_FILE`'s NUL-byte and invalid-UTF-8 checks mean anything, since a JS string has already been decoded by the time it exists.

**Windowed probe-only sniffing on the server, mirroring the client's need to avoid reading a huge `File` fully.** Rejected: `maxFileBytes` already bounds submission size before any content is inspected, and the server already holds the complete buffer in memory by the time `saveFile` runs, so a windowed probe would save nothing. `sniffProbe` stays exported, unwindowed, and available for a client-side pre-sniff in a later commit.

## Consequences

Every provider composing `LocalAttachmentStore` gains three new deployment-configurable limits (`maxFileBytes`, `maxFilesPerMessage`, `maxMessageFileBytes`, defaulting to 1MiB/10/10MiB) with no other behavior change: nothing yet calls `saveFile` or `admitEncodedFiles`, so this commit is inert until the wire, session, and request-materialization commits that follow it connect a caller to the seam. The extracted shared cores (`commitDurableObject`, `readVerifiedObject`) are exercised by the full existing image test suite, unchanged.

**Retirement.** This patch is a temporary overlay for a capability upstream does not have yet: if upstream adds text-file attachment support to `@deepseek-ai/dsh-attachment` — a file admission and storage seam mirroring images — this patch is retired and the fork adapts to upstream's form.
