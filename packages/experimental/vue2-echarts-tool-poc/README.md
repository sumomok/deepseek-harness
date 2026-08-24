# @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc

English | [中文](README.zh.md)

`show_chart`: the agent hands over a complete ECharts option, the conversation transcript paints it as a live **Vue 2.7** chart where the call sits, and what the browser actually painted comes back into the tool result.

The components come from [`vue2-echarts-poc`](../vue2-echarts-poc/README.md), which knows no layout. This package knows no layout either — it claims two keyed slots and no column: the `show_chart` key of the transcript's `tool.call.toolview` slot, which the shipped conversation owns, and the `chart` kind of the [content surface](../content-surface/README.md)'s column, which exists only where a composition opens one. The same row therefore renders under the shipped shell and under the service-line one, and where there is a column to gain it takes the column and gives the conversation back its space.

## Composition

Two overlays, both over the shipped Web surface:

- [`overlay/show-chart.patch.yml`](overlay/show-chart.patch.yml) inserts the component row and this one, and leaves the official `ui-layout` in place. This is the `develop`-shaped composition.
- [`overlay/show-chart-three-column.patch.yml`](overlay/show-chart-three-column.patch.yml) replaces `ui-layout` with the service-line shell and adds both halves of the content surface: charts in the conversation and the session's charts in the content column, from one Vue runtime. No hosted application is composed there, so the column's `page` kind never occurs.

`dsh --profile web --patch <path>` applies either one; the launcher's flags come first, so an app flag follows them:

```sh
pnpm dsh web --patch packages/experimental/vue2-echarts-tool-poc/overlay/show-chart.patch.yml --no-open
```

Every package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

## Configuration

| Field | Default | What it bounds |
| --- | --- | --- |
| `maxOptionBytes` | `65536` | Largest `option` a call may carry, as UTF-8 bytes of its JSON form. |
| `maxPoints` | `2000` | Largest total of `series[i].data` entries. The tool description states the configured value. |
| `verdictTimeoutMs` | `8000` | How long the call waits for a browser to report what it painted. |
| `screenshot` | `false` | Whether the painted chart is captured as a PNG and returned to the model as an image block. |

## The three feedback layers

A call passes through three gates, in order, and each one can end it.

**Bounds and supported types.** Before any browser is involved: the chart `id` when the call names one, the option's byte size, a non-empty `series`, every `series[i].type` in the supported set, and the total point count. A refusal costs one round trip, changes nothing, and names both the offending value and the correction.

**The render verdict.** The tool then blocks on the browser painting *this call id* — `exec.callId`, which is the same string the transcript hands the row through `ToolCallOwnerProps.callId`. ECharts reports its two outcomes on different channels, so the row does too: a document `setOption` throws on becomes `{ ok: false, error }` synchronously, and a document it accepts becomes `{ ok: true, seriesCount, pointCount }` on the first `finished` event after it. Settlement is single-shot: a second report for the same id, a report for a call that already timed out, and a report for a call this host never ran all answer `{ accepted: false }` and change nothing.

**The screenshot.** With `screenshot: true` the row also captures `chart.getDataURL({ pixelRatio: 2 })` and sends it with the verdict; the host commits it through the attachment service and appends an image block, the same lifecycle `read_image` uses. Bytes never ride the session log inline. A capture the store refuses is dropped and the verdict stands. The result carries one more sentence beside the picture, asking the model to inspect it for layout faults — an attached chart with nothing asked of it reads as confirmation and is not looked at.

Until a verdict arrives the chart is laid out but invisible (`visibility: hidden`, because ECharts sizes its canvas from a laid-out element). A failure verdict replaces it with a one-line localized error carrying the engine's own message.

Both halves meet on two routes this package owns, `/show-chart/settings` (the capture switch, read once per boot) and `/show-chart/report` (the verdict).

## Where the chart is drawn

Under the shipped layout the transcript row *is* the chart: a 340px stage where the call sits, revealed by its verdict.

Where a content column is composed, the column already shows the session's charts full height, so the row hands the picture over and keeps one compact line — `<title>: shown in the content panel.` It still mounts the engine, because the verdict and the screenshot belong to this call and the column's seat reports neither; the stage is `position: fixed` off to the side at a real size while the call waits, and unmounted the moment the verdict is in. Fixed rather than `display: none`, for the same reason the shipped stage uses `visibility`.

The row reads which case it is from the presence of the `contentSurface` projection: published exactly where a content column is composed, absent everywhere else. Two rows are exempt. A **superseded** row keeps its own notice, because it answers no call and mounts no engine either way. A **failed** chart keeps the error line in the conversation, because the column has nothing to show for a document that did not paint.

Clicking the compact card does not select that chart in the column: nothing carries a selection between the two packages' components.

## One chart, several calls

A call may name a stable chart `id` (trimmed, non-empty, at most 64 characters). Reusing an earlier chart's id means *this call replaces that chart*: both calls stay in the transcript, because the log is what happened, but the older row collapses to a one-line notice with no canvas, no engine, and no verdict behind it. A call naming no id is its own chart and can supersede nothing.

The `id` description also says when reuse is the required answer rather than an available one: a user asking to change, extend, or fix a chart already drawn — quoting it, naming its title, or otherwise pointing at it — is asking for that chart's id, because a new id draws a second chart beside the old one instead of updating it.

Which row is current is not something a row can see — it would have to read the calls after itself. The node half projects it instead, under the `showCharts` key: a pure fold of the session log into every recorded chart call (`chartId`, `callId`, `title`, `seq`) plus the call currently owning each chart id. The browser row reads it through the framework's `useProjection` seat and resolves nothing of its own.

The fold recognizes both shapes a chart call takes in the log: a top-level `tool/call`, whose `arguments` is raw JSON, and a Code Mode `tool/code-dispatch-start`, whose `arguments` is already decoded and whose call id is the `subCallId`. A model reaching the tool through `run_code` logs only the second.

The projection unit activates only when a projection registry is composed. Without one the tool and the rows work unchanged and every chart is simply the call that drew it.

## Trust

`option` is model output, rendered by a real engine inside the shell's own origin. It is not markup and it is not code — the host accepts only JSON — but three ECharts features turn plain JSON into a document the browser interprets, so the browser half rewrites exactly those three before painting ([`src/client/sanitize.ts`](src/client/sanitize.ts)):

- **`tooltip.renderMode` is forced to `richText`.** ECharts' default tooltip is HTML, and `tooltip.formatter` accepts a template string, so a model-supplied formatter would be a same-origin HTML injection. In rich-text mode the engine draws the tooltip on the canvas, where a tag is just characters.
- **`graphic` is dropped whole.** It renders arbitrary elements, including an `image` element pointing at any URL. A chart needs none of it.
- **Every `symbol`/`image` string starting with `image://` is dropped**, which is how ECharts loads a remote asset for a marker or a legend icon. Built-in symbol names are untouched.

Everything else passes through unchanged: a model writing ordinary ECharts is the point, and a sanitizer that rewrote the document would defeat it.

The report route is same-site and JSON-only: a request a browser labels `sec-fetch-site: cross-site` is refused 403 and one that does not declare `application/json` is refused 415, both before the body is read, so a cross-origin page cannot post a verdict as a preflight-free simple request. Past that fence it accepts a verdict from anything that can reach the dsh origin, exactly as the rest of the HTTP API does; a report can only settle a call already waiting for one, and its worst outcome is a wrong verdict line on one chart the user is looking at.

## Model Experience

### The `show_chart` offer

#### What the model sees

One tool, `show_chart`, with an optional `id` string, an optional `title` string, and a required `option` object whose `series` array is required. The description states the supported series types, the JSON-only rule, the configured point ceiling, that tooltips render as rich text, that the UI picks the theme, and the size of the conversation column the chart is drawn in — roughly 500×340 CSS pixels, which is what makes bottom legends and automatic layout the right defaults. This package contributes no system-prompt section.

#### Token effect

One fixed description plus the parameter schema, on every request where the tool is visible. The `option` schema is deliberately shallow — one object with one array — because the ECharts option format is something models already know; a typed per-chart schema would cost far more tokens and describe less.

#### KV Cache effect

The description is assembled once when the row loads and varies only with `maxPoints`, so the tool block stays byte-identical across requests within a deployment and the prefix holds.

### Tool-call result

#### What the model sees

A verified call answers `Rendered: <title or "chart"> — <n> series, <m> points`, and with `screenshot: true` also carries the inspection sentence and one image block, both entering model context from the next request onward. A call no browser answered in time answers `Shown; not verified (no client reported within <s>s).` followed by the sentence that keeps the model from re-issuing the same chart: the chart is in the transcript and paints when the user views it. It is not an error — no browser may be open at all. A browser that could not paint the document answers `Error: Render failed: <the engine's own message>`, so the next call can be right. Each refusal answers `Error: show_chart: …` naming the offending value, the limit, and the correction.

#### Token effect

One short line per call, two when a screenshot rides along. A screenshot adds one image, priced as an image on every subsequent request.

#### KV Cache effect

Append-only; results follow the reusable request prefix and invalidate nothing already cached.

## Known Limitations and Deferred Work

- **Four series types** — `bar`, `line`, `pie`, and `radar`. The set is [`SUPPORTED_SERIES_TYPES`](../vue2-echarts-poc/src/chart-types.ts) in the component row, which registers exactly those ECharts modules; adding one is a constant plus a module entry, and the tool description and its refusals follow automatically.
- **JSON only** — the option crosses a tool-call boundary, so an ECharts feature expressed as a function (a `formatter` callback, a `symbolSize` function, a custom series renderer) cannot be sent at all.
- **The verdict comes from the first client that reports** — several browsers may show the same session, and whichever paints first answers the call. They are painting the same document, so the counts agree; a browser whose engine refused a document another accepted would not.
- **A screenshot needs a vision-capable model** — the image block enters context whether or not the route accepts images, and costs image tokens on every later request. It is off by default for both reasons.
- **The column shows one chart per id, and never reports a verdict** — the `chart` seat draws the selected entry and nothing else. The call it would answer settled when the transcript row answered it, so a chart the user merely selects again reports nothing and captures nothing.
- **The compact card is not a link into the column** — beside a content column the transcript row is one line of text, and clicking it selects nothing. The two components live in different packages with no channel between them, and a component may not subscribe to anything of its own.
- **A compact row still pays for its engine once** — the picture is the column's, but the call's verdict is not, so every current chart builds one ECharts instance off-screen and disposes it on the verdict. A transcript replayed with hundreds of charts pays that cost per row as it scrolls into view.
- **A chart entry carries its whole option** — the column's projection stores the option document per live chart id, so it rides the wire value and the persisted checkpoint. `maxOptionBytes` is what bounds it.
- **The chart reads the palette once** — the row reads `body[data-ds-dark-theme]` when it mounts. A theme switch repaints the shell around a chart that keeps the palette it was built with, until the transcript remounts the row.
- **The report route assumes an HTTP carrier** — the browser half posts to `/show-chart/report` relative to the page origin. A transport that serves the shell without exposing the harness over HTTP would leave every call unverified.
- **The model is not told a chart was superseded** — the replacement is a browser-side render decision. The tool result of the older call is whatever it was when the call settled, and nothing revisits it.
- **The projection grows with the session's chart calls** — one small entry per call, kept for the life of the session, and its `title` is carried as the model wrote it. Nothing trims either; a session that draws hundreds of charts pushes a correspondingly larger value to the browser.
- **No interaction reaches the model** — a click, a legend toggle, or a zoom stays in the browser. The agent can put a chart in front of the user; it cannot learn what the user did with it.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition, and the model-visible text is pinned verbatim in unit tests; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
