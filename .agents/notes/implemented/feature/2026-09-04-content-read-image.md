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

Five mechanisms, each against the same five blanks. A boundary with no failure it prevents is noise and is not listed; every one that is listed is marked permanent, or deferred with the trigger that reopens it.

#### The tool and its two gates

- **0 — what a settled principle already answered.** "Plugins, not loop changes" said no to touching `agent-loop`: this is one more tool on the channel this package already owns. "A capability seam is three roles, never one" said no to declaring a picture-taking service — there is one implementation and one consumer, inside one package. "Model-visible ⟺ logged" said no to putting pixels into a request that no session event records, which is what put the answer in a stored attachment named by the `tool/result` rather than in the request directly. This package's own settled rule that reads need no approval said no to an approval gate, so none was designed.
- **1 — new surfaces: 6.** The tool name, the required `ref` parameter, the wire request kind, the `ReadOutcome` arm (`status: 'image'`), the output schema, the description. Not a `ReadKind`, not a `Config` field, not an approval gate, not an event type: the arm is a third ending of a read, not a fourth way of reading.
- **2 — v0.** The version that decided this was not a version of the tool at all — three pictures off a real console, handed to the model by hand (Evidence below). The cheapest tool that would still have answered is one `img` by `ref`, exported at its own size and attached, with no other tag, no scaling and no modality gate; every part left out answers a condition the same three pictures already showed, because that console draws its chart in a `canvas` and its commands in `svg`.
- **3 — seam or hardcode.** Hardcoded. A seam here would be a picture-taking service another package could call, and it needs two named callers that will really exist; there is one, in this file. The one seam in the whole change is the drawing primitive, and it belongs to the mechanism below.
- **4 — boundary.**

| Direction | The line | The failure it prevents | Standing |
| --- | --- | --- | --- |
| Neighbour | The tool decides nothing about pixels: what a picture is, is the seat's; what may be kept, is the store's. | Two halves deciding what an image is, and drifting the first time either moves. | permanent |
| Contract | Both gates — the `ref`'s spelling, then the session's route — run before the wait opens, in that order. `isConcurrencySafe` is true. | A picture stored for a request that will drop it: the store keeps what it is given for good. | permanent |
| Temptation | Reaching for the picture in place of a read. A `ref` comes only from a read that already ran, and the description says what the element has to be rather than when to prefer it. | An agent that looks instead of reading, at 117–349 tokens a look. | permanent |
| Red line | Nothing is read out of the picture on the way past: no decode, no caption, no OCR, no classification. The header line states sizes, format and bytes. | This package inventing a payload the model can see for itself — and being believed. | permanent |
| Ceiling | One element, once, at what the page drew. No region, no subtree, no `video` frame, no retry at another size, and no picture in the session card. | It being taken for a screenshot tool, which is the path this read exists to close. | deferred on the card — trigger: `tool.call.images` upstream becoming keyed or accepting a second declaration; permanent on the rest |
| Assumption | The session's route declares image input and the `ref` names an element in this session's own column. An absent `inputModalities` is a no, and an unresolvable route is a refusal. | Guessing a modality and storing pixels the request then drops. | permanent |

#### The capture in the seat

- **0 — what a settled principle already answered.** "Prefer maintained dependencies over hand-rolling **when they genuinely delete owned code and tests**" was read both ways and answered no: a DOM-to-canvas library replaces four browser calls and deletes no test. "Explicit > implicit at package boundaries" said no to a drawing that picks its own size — `exportSize` resolves it and the primitive is told. "Trust TypeScript at typed same-process boundaries" said no to re-validating what `captureElement` is handed inside one process.
- **1 — new surfaces: 4.** Two modules — [`capture.ts`](../../../../packages/experimental/content-frame/src/client/access/capture.ts), every decision an export makes, and [`export-pixels.ts`](../../../../packages/experimental/content-frame/src/client/access/export-pixels.ts), the four browser calls that make one — plus the injected primitive on the seat (`draw`) and the deadline it runs under (`budgetMs`).
- **2 — v0.** An `img` drawn at its stored size with `drawImage` and `toBlob`, and nothing else: no visibility check, no size arithmetic, no media-type read-back. Every check that followed answers an ending the fixture page produced on its own — hidden, unloaded, zero-size, tainted, and a drawing that never came back.
- **3 — seam or hardcode.** One seam, and it names its two implementations: `export-pixels.ts`, which is the browser's, and the recording stub every case in `content-image-capture.client.spec.ts` injects, because jsdom has no canvas and this package takes no native one. Everything around it is hardcoded — the tag list, the order of the checks, the two size rules.
- **4 — boundary.**

| Direction | The line | The failure it prevents | Standing |
| --- | --- | --- | --- |
| Neighbour | Layout and visibility belong to the frame they are measured in: the export reuses the same `isSkipped` and the same injected visibility every read uses. | Two definitions of "visible", so a read prints an element the export then refuses. | permanent |
| Contract | The checks run in a fixed order and the first failure is the refusal; the export reads and never writes, and nothing is added to the frame's document. | An export waking the change watch a read waits on, so a read after a picture never settles. | permanent |
| Temptation | A DOM-to-canvas library, or a native `canvas` package, to make the drawing testable. | A build toolchain inside a package whose whole primitive is `createElement`, `getContext`, `drawImage`, `toBlob`. | permanent |
| Red line | Cross-origin pixels are never exported: a tainted surface is a refusal, and nothing tries `crossorigin`, a proxy fetch, or a server-side re-fetch of the `src`. | This console handing on pixels the browser refused, past the rule the browser keeps. | permanent |
| Ceiling | What the browser hands back, once, inside one share of the read's deadline. No promise that a WebGL canvas has a frame to give, that a vector's external references come along, or that two machines encode the same bytes. | Being read as a renderer rather than as a read of what a browser already drew. | deferred — trigger: a real page reporting a blank WebGL export, which is when "the export succeeded and the pixels are empty" has to become a refusal |
| Assumption | The element is in a same-origin document this seat can reach, and the engine has a canvas. Neither is worked around: no context is a throw, reported as the reader failing. | Returning an empty picture where an engine has no canvas, which reads as a page that drew nothing. | permanent |

#### The picture route

- **0 — what a settled principle already answered.** "Trust TypeScript at typed same-process boundaries — and validate at wire boundaries" made the parser non-optional, and made it the only validation in the change that is not a type. "Misconfiguration fails loud" said no to a route that quietly ignores a payload it cannot read. "Explicit > implicit" said no to inferring the media type from the bytes: it is read off the blob and checked against a closed set.
- **1 — new surfaces: 4.** One route path (`POST /content-frame/image`), one wire document (`ImageReportRequest`), one parser (`parseImageReport`), one byte bound (`IMAGE_REPORT_BYTES`).
- **2 — v0.** The route with the parser and no store behind it: post, parse, settle. It is what `content-read-wire.client.spec.ts` still drives on its own, and it is what settled the arithmetic before any picture was kept — the bound is the base64 of `MAX_EXPORT_BYTES` plus the envelope, and a payload at exactly `MAX_IMAGE_DATA_CHARS` has to be taken.
- **3 — seam or hardcode.** Hardcoded: one fence, one media-type set, one bound, one caller. The two variants a seam would need cannot be named — every poster is this package's own seat — and the bound is not a `Config` field because it is computed from the provider's own accounting.
- **4 — boundary.**

| Direction | The line | The failure it prevents | Standing |
| --- | --- | --- | --- |
| Neighbour | The route parses and delivers. Whether a picture may be kept is the store's answer, and whether a call is waiting is the table's. | A route composing refusals the tool cannot compose, in a vocabulary the model never sees. | permanent |
| Contract | `/content-frame/report` is untouched — its bound and its parser are the text reads' — and an image read's failures travel this route too, so one call id is never raced by two routes. | Two routes settling one call, whichever arrives first. | permanent |
| Temptation | Sending the bytes through the report route, which already exists and already parses an outcome. | Every text read paying a byte bound sized for a payload no text read produces. | permanent |
| Red line | The payload is checked — base64 alphabet, length, bound, closed media-type set — before anything is decoded, and nothing is written for a call nobody is waiting on. | An unauthenticated POST writing megabytes into a store that collects nothing. | permanent |
| Ceiling | One picture per post, at most `MAX_EXPORT_BYTES`. No chunking, no resume, no second attempt at a smaller size. | A retry ladder growing inside a route. | deferred — trigger: a real element on a real console being refused by `MAX_EXPORT_BYTES` |
| Assumption | The caller is this package's own seat, and the call id was minted by the host and published only into that session's projection stream. There is no Host fence and no authentication here. | Reading the id's unguessability as a property this package owns; it is the provider's, and a deployment on an untrusted network fences at its proxy. | permanent |

#### The host half: stored before settled

- **0 — what a settled principle already answered.** "Model-visible ⟺ logged" fixed the order on its own: the reference the log records has to name an object that exists when the event is appended. "Validate at durable boundaries" left the image limits and the normalization where they already are, in the store. "An empty `catch` names what it swallows" said no to swallowing the store's refusal — it is caught and turned into a sentence the model reads.
- **1 — new surfaces: 3.** One module ([`image-report.ts`](../../../../packages/experimental/content-frame/src/access/image-report.ts)), one service in this package's inject list (`attachments`), and one method on the call table (`PendingCalls.isWaiting`).
- **2 — v0.** Store, then hand the reference to the table. No queue, no background write, no cleanup pass — that is the whole mechanism, and it is small enough that the one thing it was missing is a single `isWaiting` in front of it, reading the acceptance `report` already applies.
- **3 — seam or hardcode.** Hardcoded. The order is not configurable and the store is not swappable here: `attachments` is the repository's own capability and this module is one consumer of it. A second store would be a second provider behind that capability, not a second seam in this file.
- **4 — boundary.**

| Direction | The line | The failure it prevents | Standing |
| --- | --- | --- | --- |
| Neighbour | Image limits, normalization and naming policy stay the attachment store's; this module hands it bytes, a media type and a name, and passes its refusal through. | Two places deciding what an image may be, with the model told the losing one. | permanent |
| Contract | Pixels are on disk before the call settles, and only for a call the table is holding for the posting tab. | A `tool/result` naming an object that is not there, and bytes nothing will ever read or remove. | permanent |
| Temptation | Settling first and storing in the background, which reads faster. | A reference to nothing in a log that outlives the request. | permanent |
| Red line | No store, no tool: the registration is inside `ctx.inject(['tools', 'attachments'], …)`, and without one the tool is absent and the route is not mounted. | A deployment offering a read that has nowhere to put its answer. | permanent |
| Ceiling | It keeps what it is given. There is no expiry, no quota, and no delete-after-turn; a call that times out while the store is writing still leaves its bytes. | This package inventing a retention policy the store does not have. | deferred — trigger: the attachment store growing a collection policy of its own |
| Assumption | The store's failures are `AttachmentError` and are its own to describe, and the call table is the only thing that knows whether a call is waiting. | Guessing at a reason this side does not have, and telling the model the console went quiet for a failure already known here. | permanent |

#### The export constants

- **0 — what a settled principle already answered.** "No hardcoded tunables in plugins: deployment-varying choices are validated `Config` fields" — read as it is written, it says a choice that does **not** vary by deployment stays a constant, and names protocol constants and external specs as exactly that. All five are one or the other, so the `Config` block gained nothing.
- **1 — new surfaces: 5.** Four protocol constants in [`wire.ts`](../../../../packages/experimental/content-frame/src/access/wire.ts) — `IMAGE_MEDIA_TYPE`, `IMAGE_PIXEL_BUDGET`, `SVG_RASTER_MIN_PIXELS`, `MAX_EXPORT_BYTES` — and the share of the read's deadline the export runs under, `EXPORT_WAIT_SHARE`. Zero `Config` fields.
- **2 — v0.** One constant — the byte cap — with the element's own size and no scaling in either direction. The probe is what said that is not enough: a 24-pixel `svg` rasterized at 24 pixels is not a picture anything reads, and the number it should be rasterized at already existed as the provider's own floor.
- **3 — seam or hardcode.** Hardcoded, all five. Two deployments that would set any of them differently would have to be named, and cannot be: these are the provider's pricing, the attachment layer's projection, the format a canvas falls back to, and a fraction of a deadline this package already splits.
- **4 — boundary.**

| Direction | The line | The failure it prevents | Standing |
| --- | --- | --- | --- |
| Neighbour | Pricing belongs to the provider and projection to the attachment layer; each constant restates one of theirs and names where it came from. | This package inventing a number, then drifting from the layer that owns it with nothing to notice by. | deferred — trigger: the provider's `MIN_PIXELS` or the attachment layer's `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET` moving |
| Contract | A bitmap is never enlarged, a vector always is, and both are then held to the pixel budget by the same geometry the attachment layer projects a request image with. | Bytes with no detail before a floor that would have scaled them anyway, and detail thrown away before that floor asks for it. | permanent |
| Temptation | Making any of them a `Config` field, because they look like tuning. | A deployment paying for pixels no request carries. | permanent |
| Red line | An export past the cap is refused with its size, never re-encoded at a lower quality. | Answering a question about a QR code with a picture that no longer decodes. | permanent |
| Ceiling | 2 MiB, PNG, one pixel budget, and an eighth of the read's deadline. Nothing promises that a picture past any of them arrives at all. | A ladder of fallbacks — a smaller size, a lossier format, a longer wait — growing where a refusal belongs. | deferred — trigger: a real element being refused by `MAX_EXPORT_BYTES`, which is the same trigger the route's ceiling carries |
| Assumption | A canvas encodes PNG, which the HTML specification requires as the fallback for any type an engine does not support; what is reported is `blob.type` read back rather than what was asked for. | Describing bytes nobody produced. | permanent |

### Evidence

Before any of this was written, three pictures taken off a real console were handed to `deepseek-v4-flash-vision-exp` directly, one at a time, n = 1 each:

- a sign-in QR code — named as a QR code, with its payload not read out: the model said what the picture was and declined to invent what it encoded;
- a row of drawn row commands — read as a pencil and a wastebasket, which is exactly the column the markup reads print empty;
- a bar chart drawn into a `canvas` — the highest month read off it, August.

Three pictures, one model, n = 1 each, chosen because the five text reads answer nothing about any of them. It measures no accuracy and stands in for no measurement of one. What it settles is the question the second blank asks — whether a vision model answers what a page draws well enough to be worth a tool at all — and the recorded Web scenario reproduces the first of the three end to end, through the real channel.

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

An export that never comes back ends as a refusal about this picture rather than as the channel's timeout sentence. The drawing gets an eighth of the read's deadline of its own, after the load wait's half and the settle wait's quarter; nothing in a browser cancels a `toBlob` or an `image.decode()`, so what the deadline ends is the seat's wait for it, and the promise stays pending for the life of the tab. The call settles at the seat rather than at the host, and the model is told `<ref> did not finish exporting within Ns.` instead of that the console went quiet.

## Testing

`tests/content-image-capture.client.spec.ts` drives every export decision against real documents with the drawing primitive injected — the four tags and the refusal of every other, the visibility, loaded, zero-pixel and taint refusals, the deadline a drawing that never returns runs out, the cut a tag the page spelled past the wire's bound is taken to, the media-type set, the byte cap, and the exact exported sizes a downscale and an SVG upscale produce. `tests/content-read-image-tool.client.spec.ts` pins the description, the parameter list and the header line verbatim against the real tool runtime, and drives both arms of the modality gate, the failure arm, the misreported arm, and the image block's attachment reference. `tests/content-image-report.client.spec.ts` holds the host half: the exact decoded bytes reach the store, the stored name follows the page and the element, the settled call carries a reference and no bytes, a refusing store settles the call with its own reason, the store is left untouched for a call nobody is waiting on and for one another tab claimed, and the pixels are committed before the call settles rather than after. `tests/content-read-wire.client.spec.ts` covers the new parser and the route's byte arithmetic, `tests/content-read-routes.client.spec.ts` the route itself, and `tests/self-contained-copy.client.spec.ts` walks the seventh tool definition and all eleven new strings. `src/` stays covered per file at 100%.

One Web scenario backs it: `apps/web/tests/content-read-image.e2e.ts`, against the same `tests/fixtures/markup-app` the markup scenarios use, which gains a pairing QR code with no alternative text, a `canvas` drawing a fixed eight-bar chart, and an inline `svg` star. It has a patch layer of its own, [`content-read-image.overlay.yml`](../../../../apps/web/tests/content-read-image.overlay.yml), naming the route this composition's sessions start on, and the spec then selects that route on the seeded session through `sessionController.selectModel` — the call the composer's model picker makes. The layer alone does not route the session and cannot: a session that already logged a request header derives its route from its own log, and the composition's default applies only to a session that logged none ([`selectionFor`](../../../../packages/api/session-controller/src/agent.ts)). The seed these scenarios replay logged one. The spec asserts the selected route and its declared image input before it drives the prompt, so a session on the wrong route fails there rather than as three refusals inside the turn.

The session is also composed from a preset of its own, [`tests/fixtures/presets/content-column`](../../../../apps/web/tests/fixtures/presets/content-column/agent.cordis.yml), which mounts no tools: handed a QR code and a shell, the model installed OpenCV over the network and decoded the payload out of the stored attachment, which is a transcript no replay reproduces. Every model tool the Web profile offers comes from a preset — the profile disables all of its `tool-*` rows and `standard` mounts them again — so a patch layer cannot take one away, and what is left with no preset tools at all is exactly the content column's seven. The spec pins that list before it drives the prompt too. The page is served at `?pictures=code`, which leaves it one picture, and the reason is what the recording pins: the harness compares the whole replayed log against the recorded one, and a picture's `attachmentId` is a content hash of the exported bytes that the replay re-derives live — so the recording pins every export the turn makes, not only the one the assertions read. A checked-in PNG decoded and re-encoded produces the same bytes wherever it replays; the `canvas` and the `svg` in that page are rasterized by the browser, where fonts and antialiasing are not promised to agree across platforms or across engine versions, and a recording that had read them would drift on both. They stay in the page for this package's own suite, and the spec asserts that the frame in front holds exactly one picture before it drives the prompt. Record it with a key:

```sh
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-image.e2e.ts
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-image.e2e.ts
```

The refresh is keyless and is not optional, for the reason the four text scenarios' is not: a recording carries what the live provider resolved, which a replayed run never produces. The spec skips itself while `snapshots/web/content-read-image/` is absent, so the scenario and its recording may land in different changes without turning a keyless lane red.
