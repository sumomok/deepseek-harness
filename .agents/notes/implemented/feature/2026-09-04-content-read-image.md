# Agent Note: one picture on the page, as pixels the model looks at

Status: implemented

English | [中文](2026-09-04-content-read-image.zh.md)

## Problem

The five content reads all answer with text about the page, and a console draws things that no text about them describes. A pairing QR code is an `img` with no alternative text, no title and no name: the listing prints nothing for it, `content_read_dom` prints `img#pairing {class: code}`, `content_read_attrs` prints `src="/pairing?ts=1788…"`, and `content_read_dom_content` prints an empty answer. Every one of those is a correct reading of what the page was written as, and none of them says what the page shows. The same holds for a captcha, for a chart painted into a `canvas`, and for an icon drawn as an `svg` path rather than as a character.

[The sign-in note](2026-09-04-sign-in-pages-are-read.md) recorded where that ends. A user asked for help with a console's sign-in page — one drawing a QR code and a captcha — and what was wanted was the agent's reading of what the page showed. With the reads answering only about the page's spelling, the model reached for `bash screencapture` over the whole display and read the PNG back through `read_image`: everything on that screen at that moment arrived as pixels, through a tool with no rule about any of it, at whatever resolution the display happened to be. Deleting the page-level refusal removed the reason the model left the channel; it did not give the channel an answer to the question the model had.

## Decision

One more read, `content_read_image`, with one required parameter: a `ref` an earlier read of this page printed. It answers with the element's own rendered pixels — exported in the browser seat, stored by the host, and attached to the tool result as an image block the model looks at — beside one line of facts about what came out.

Four tags carry pixels of their own and are the whole of what this read takes. An `img` and a `canvas` export their own stored raster; a `picture` exports the `img` it renders through, recorded under the wrapper's tag; an `svg` has no stored raster and is rasterized at its layout box. Any other tag is refused by its tag, before anything is drawn.

The read is not a screenshot. It takes one element and never a region, a subtree, the column, or the display, so what it can answer with is bounded by what the page itself drew into one box — and a `ref` is minted only by a read of the page in this session's own content column.

Reads need no approval and this one is a read. What it can carry is what an element draws: a screenshot of an `img` cannot contain the value inside a password box, because that value is not a pixel of that `img`. The withholding rule [the sign-in note](2026-09-04-sign-in-pages-are-read.md) states — a password control's value never reaches the model — is unaffected and needs no new arm here.

### The gate

#### The tool and its two gates

- **New surface.** One tool, one required parameter, one wire request kind, one `ReadOutcome` arm (`status: 'image'`), one output schema, one description. No new `ReadKind`: the arm is a third ending of a read, not a fourth way of reading.
- **Boundary.** The tool decides nothing about pixels. It checks the `ref`'s spelling, checks the session's route, waits on the channel the five text reads already wait on, and turns one settled arm into two model-facing blocks.
- **Contract.** Both gates run before the wait opens, in that order, because a stored picture is permanent: a call that cannot succeed must fail before a seat exports anything. `isConcurrencySafe` is true — the read writes nothing to the page and storing pixels is content-addressed.
- **Temptation.** Reaching for the picture in place of a read. A `ref` can only come from a read that already ran, so a page has to have been read before this can name anything on it, and the description says what the element has to be rather than when to prefer it.
- **Red line.** Nothing is read out of the picture on the way past. The tool does not decode, caption, OCR, or classify: what it shows is the model's to say, and the header line states only sizes, format and bytes.

#### The capture in the seat

- **New surface.** Two modules: [`capture.ts`](../../../../packages/experimental/content-frame/src/client/access/capture.ts) holds every decision an export makes, and [`export-pixels.ts`](../../../../packages/experimental/content-frame/src/client/access/export-pixels.ts) holds the four browser calls that make one.
- **Boundary.** The split is drawn at what a DOM implementation without a canvas can run. The decisions — which tag, visible, loaded, non-zero, what size, which media type, how many bytes — are pure and tested; the drawing primitive is injected into the seat and is the one thing a test does not reach.
- **Contract.** The checks run in a fixed order and the first one that fails is the refusal: not a picture, hidden, unloaded, zero pixels, tainted, unsupported format, too many bytes. Visibility is the same `isSkipped` every read already uses, so an element a read would have passed over is not exported either.
- **Temptation.** Taking a DOM-to-canvas library, or a native `canvas` package, to make the drawing testable. Either puts a dependency — one of them a build toolchain — into this package for a function whose whole content is `createElement`, `getContext`, `drawImage`, `toBlob`.
- **Red line.** Cross-origin pixels are never exported. A tainted surface throws in the browser and the throw is turned into a refusal that states the reason; nothing tries `crossorigin`, a proxy fetch, or a server-side re-fetch of the `src`.

#### The picture route

- **New surface.** One route, `POST /content-frame/image`, with a byte bound of its own.
- **Boundary.** It carries base64 inside JSON behind the same same-site, `application/json` fence the claim and report routes keep. `/content-frame/report` is untouched.
- **Contract.** Its bound is computed from what one export may carry (`IMAGE_REPORT_BYTES` = the base64 of `MAX_EXPORT_BYTES`, plus the envelope), not from the deployment's `outlineChars`. An image read's failures travel this route too, so one call id is never raced by two routes.
- **Temptation.** Sending the bytes through the report route, which already exists and already parses an outcome. That raises the byte bound on every text read to make room for a payload no text read produces.
- **Red line.** The route parses what it is given: the payload is checked for base64 alphabet, length and bound, and the media type against a closed set, before anything is decoded or stored.

#### The host half: stored before settled

- **New surface.** [`image-report.ts`](../../../../packages/experimental/content-frame/src/access/image-report.ts), and the `attachments` service in this package's inject list.
- **Boundary.** It is the one place that turns posted bytes into a durable reference. A seat posts bytes and never a reference, because it has no store; a settled call carries a reference and never bytes, because a tool result is written to a log that outlives the request.
- **Contract.** Pixels are committed before `pending.report` is called, so the reference the session log records names an object that is already on disk. A store that refuses settles the call with the store's own reason rather than throwing, which would leave the call waiting out its whole deadline for a failure this side already knows.
- **Temptation.** Settling first and storing in the background, which reads faster and puts a reference to nothing into a durable log.
- **Red line.** No store, no tool. The registration is inside `ctx.inject(['tools', 'attachments'], …)`, so a deployment without an attachment store is offered the five text tools, this one is absent, and its route is not mounted.

#### The export constants

- **New surface.** Four protocol constants in [`wire.ts`](../../../../packages/experimental/content-frame/src/access/wire.ts), zero `Config` fields.
- **Boundary.** Each is anchored to something outside this package: PNG because it is lossless and is what a canvas falls back to for any unsupported type; `IMAGE_PIXEL_BUDGET` = 640,000, the attachment layer's own `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET`; `SVG_RASTER_MIN_PIXELS` = 384 × 384, the provider's `MIN_PIXELS` floor in [`image-tokens.ts`](../../../../packages/llm/llm-deepseek/src/image-tokens.ts); `MAX_EXPORT_BYTES` = 2 MiB, twice the provider's per-image request budget, which is the headroom losslessness needs.
- **Contract.** A bitmap is never enlarged and a vector always is: enlarging a bitmap adds bytes and no detail before a floor that will scale it anyway, and rasterizing a vector at a 24-pixel layout box throws away exactly the detail that floor is about to ask for. Both are then held to the pixel budget by the same geometry the attachment layer projects a request image with.
- **Temptation.** Making any of them a `Config` field. None of them varies by deployment: they are the provider's accounting and the attachment layer's projection, and a deployment that changed one would be paying for pixels no request carries.
- **Red line.** An oversized export is refused with its size, never re-encoded at a lower quality. A lossy retry would answer a question about a QR code with a picture that no longer decodes.

## Alternatives considered

**A screenshot of the content column.** The obvious shape, and what the model already did with `screencapture`. It needs `getDisplayMedia` (a user gesture and an OS-level permission prompt per session) or a headless browser on the host (a second rendering of a page whose state lives in the user's browser). Both answer with everything in the frame — including whatever else the page draws — where the question is about one element, and neither produces a picture the model can point back at by `ref`.

**Rasterizing an arbitrary subtree.** A `scope` parameter instead of one element, so any region could be exported. There is no browser primitive for it: rasterizing markup means serializing a subtree with its computed styles into an SVG foreignObject, or taking a DOM-to-canvas library. Both re-render the page a second way, disagree with what the user sees in ways nobody can audit, and put the correctness of a picture into this package. One element that has pixels of its own is answerable exactly.

**A `canvas` npm package, so the export runs in Node.** It would make the drawing primitive testable and let a host-side path exist. It also puts a native build toolchain into a package whose whole export is four browser calls, and it would still not have the page: the pixels are in the user's browser, not on the host.

**A new `ReadKind`.** The three markup reads are `ReadKind`s of one snapshot, so a fourth looked symmetric. But a `ReadKind` names a way of rendering the page as text into `ReadSnapshot`, and this answer is not text and has no snapshot. A third arm of `ReadOutcome` says what it is: a read that ended with a picture rather than a listing. It also forced [`isActOutcome`](../../../../packages/experimental/content-frame/src/access/wire.ts) into its affirmative form — it had been written as "not a read", which silently classified any new read arm as an act outcome.

**No modality gate — attach the picture and let the request drop it.** Simpler, and wrong in a way that cannot be undone: the pixels are already on disk when the route drops the block, the store keeps them for good, and the model is left with a header line describing a picture it was never shown. A refusal that names the model costs one call and stores nothing.

**Upscaling bitmaps to the provider's floor here.** The provider scales a small image up before pricing it, so a 240 × 240 icon is priced as 384 × 384 either way. Doing it here would add bytes to the post, to disk and to the request for no detail the model did not already have.

**Rendering the picture in the session card.** The `tool.call.images` child slot upstream is `kind: 'single'` and is declared by one entry already ([`read-image-row.tsx`](../../../../packages/client/ui-tool/src/client/tool/toolviews/read-image-row.tsx)); a second declaration throws at load in [`ui-slots`](../../../../packages/client/ui-slots/src/index.ts). Registering a toolview here would either take the slot from the built-in image read or fail the console outright, so this package registers none and the settled card falls back to the generic one.

## Consequences

The model can answer what a page draws, on the same channel and with the same `ref`s as every other read, and the `screencapture` path that [the sign-in note](2026-09-04-sign-in-pages-are-read.md) recorded now has a bounded alternative: one element instead of a display, at the element's own size instead of the screen's.

The card shows the header line and not the picture, for the slot reason above. A user reading the transcript sees which element was exported, at what size, in what format and how large — and has to open the page to see what the agent saw.

Every exported picture is permanent. The attachment store keeps what it is given and collects nothing, so each read leaves a PNG in `$DSH_HOME/attachments/` for the life of that home, and it travels with any export of the session log. A sign-in QR code read once is a sign-in QR code kept forever.

The picture enters the request as a synthetic `user` message immediately after the tool result that produced it, so the request suffix changes from the first picture read onward while the prefix in front of it holds. One picture costs 117 tokens at or under the provider's floor and 349 at the whole pixel budget, against the provider's 384-token cap.

A deployment on a text-only route gets the tool and a refusal naming its model; a deployment with no attachment store gets neither the tool nor the route. Both are visible at the point of use rather than at load, because both are properties of the session and the composition rather than of the configuration block.

## Testing

`tests/content-image-capture.client.spec.ts` drives every export decision against real documents with the drawing primitive injected — the four tags and the refusal of every other, the visibility, loaded, zero-pixel and taint refusals, the media-type set, the byte cap, and the exact exported sizes a downscale and an SVG upscale produce. `tests/content-read-image-tool.client.spec.ts` pins the description, the parameter list and the header line verbatim against the real tool runtime, and drives both arms of the modality gate, the failure arm, the misreported arm, and the image block's attachment reference. `tests/content-image-report.client.spec.ts` holds the host half: the exact decoded bytes reach the store, the stored name follows the page and the element, the settled call carries a reference and no bytes, a refusing store settles the call with its own reason, and the pixels are committed before the table is asked. `tests/content-read-wire.client.spec.ts` covers the new parser and the route's byte arithmetic, `tests/content-read-routes.client.spec.ts` the route itself, and `tests/self-contained-copy.client.spec.ts` walks the seventh tool definition and all ten new strings. `src/` stays covered per file at 100%.

One Web scenario backs it: `apps/web/tests/content-read-image.e2e.ts`, against the same `tests/fixtures/markup-app` the markup scenarios use, which gains a pairing QR code with no alternative text, a `canvas` drawing a fixed eight-bar chart, and an inline `svg` star. It has a patch layer of its own, [`content-read-image.overlay.yml`](../../../../apps/web/tests/content-read-image.overlay.yml), naming the route this composition's sessions start on, and the spec then selects that route on the seeded session through `sessionController.selectModel` — the call the composer's model picker makes. The layer alone does not route the session and cannot: a session that already logged a request header derives its route from its own log, and the composition's default applies only to a session that logged none ([`selectionFor`](../../../../packages/api/session-controller/src/agent.ts)). The seed these scenarios replay logged one. The spec asserts the selected route and its declared image input before it drives the prompt, so a session on the wrong route fails there rather than as three refusals inside the turn. Only the `img` is pinned — a checked-in PNG decoded and re-encoded is the one export path that produces the same bytes on the recording machine and the replaying one, while a canvas and a vector are rasterized by the browser, where fonts and antialiasing are not promised to agree across platforms. Record it with a key:

```sh
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-image.e2e.ts
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-image.e2e.ts
```

The refresh is keyless and is not optional, for the reason the four text scenarios' is not: a recording carries what the live provider resolved, which a replayed run never produces. The spec skips itself while `snapshots/web/content-read-image/` is absent, so the scenario and its recording may land in different changes without turning a keyless lane red.
