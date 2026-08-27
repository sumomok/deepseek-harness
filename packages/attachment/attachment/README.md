# @deepseek-ai/dsh-attachment

English | [中文](README.zh.md)

The durable attachment seam. `ctx.attachments` validates and durably commits a provider-independent normalized image, then returns a serializable `ImageAttachmentRef`; consumers never persist browser paths, object URLs, provider URLs, or base64 in session events.

Unsent composer images remain browser-owned temporary drafts. `validateImage` runs the complete admission policy without persisting. `saveImages` owns batch count and aggregate-byte limits, prepares every normalized attachment before publishing any member, then commits in order and returns references only after the complete batch succeeds. A later storage failure returns no partial references, although an earlier immutable content-addressed object may remain unreachable until reference-aware garbage collection exists. `AttachmentError.code` uses the closed `AttachmentErrorCode` string union. Its `ImageAdmissionErrorCode` subset marks caller-correctable image-input failures; `isImageAdmissionError` recognizes that subset at runtime so each protocol adapter can map its own error vocabulary. `saveImage` commits one accepted image before any model-visible session event is published and returns its `ImageAttachmentRef`. When normalization reduces the raster, the reference records the orientation-applied input size in `originalDimensions`. `readImage` verifies the normalized attachment against its logged metadata. `readImageRequest` deterministically derives a route-sized request version whose identity covers the attachment id, transform version, pixel and byte budgets, and encoder settings. Callers compose ordered batches with `Promise.all(refs.map(...))`; the local implementation still bounds compression through its instance limiter, cache, and singleflight. Callers may cancel reads and projections; implementations preserve cancellation instead of translating it into a storage failure.

`admitEncodedImages(attachments, images)` is the shared wire entry used by every RPC endpoint that accepts browser uploads (the session prompt endpoint and the command executor): it enforces canonical base64 on every member, then delegates batch admission — limits, validation, ordered commit — to `saveImages`. The base64 upload form is `EncodedImageAttachment`, exported from `@deepseek-ai/dsh-attachment/types` so wire contracts can reference it.

Text files follow the same seam, mirrored: `validateFile`/`saveFiles`/`saveFile`/`readFile` and `FileAttachmentRef`/`SaveFileAttachment`/`StoredFileAttachment` parallel their image counterparts one for one. A `FileAttachmentRef` always carries a `name` (a file card has nothing else to show); it carries no media type, width, or height — those concepts do not apply to text. `admitEncodedFiles(attachments, files)` is the file wire entry: its upload form, `EncodedFileAttachment`, carries plain UTF-8 text rather than base64 (there is no binary transport ambiguity to canonicalize), and admission re-encodes it to bytes so `saveFiles` validates every upload at the byte level regardless of transport. `AttachmentError.code`'s `FileAdmissionErrorCode` subset (`TOO_MANY_FILES`, `FILES_TOO_LARGE`, `FILE_TOO_LARGE`, `NOT_TEXT_FILE`, `INVALID_FILE_NAME`) marks caller-correctable file-input failures; `isFileAdmissionError` recognizes that subset at runtime.

## Model Experience

Indirectly, through the role-neutral core `ImageBlock` and provider adapters that resolve its durable reference into an exact request version. Request descriptors expose the complete attachment id and actual request dimensions.

#### KV Cache effect

Adding an image changes the provider request and therefore invalidates the affected request suffix.

## Known Limitations and Deferred Work

- Version one accepts PNG, JPEG, WebP, and GIF images, plus UTF-8 text files of any extension.
- Retention and garbage collection are deferred because resumed and forked sessions may share immutable objects.
- Audio, video, and persistent unsent drafts require separate lifecycle and provider contracts.
