# @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc

English | [中文](README.zh.md)

`show_chart`: the agent hands over a complete ECharts option, the conversation transcript paints it as a live **Vue 2.7** chart where the call sits, and what the browser actually painted comes back into the tool result.

The components come from [`vue2-echarts-poc`](../vue2-echarts-poc/README.md), which knows no layout. This package knows no layout either: it claims the `show_chart` key of the transcript's `tool.call.toolview` slot, which the shipped conversation owns, so the same row renders under the shipped shell and under the service-line one.

## Composition

Two overlays, both over the shipped Web surface:

- [`overlay/show-chart.patch.yml`](overlay/show-chart.patch.yml) inserts the component row and this one, and leaves the official `ui-layout` in place. This is the `develop`-shaped composition.
- [`overlay/show-chart-three-column.patch.yml`](overlay/show-chart-three-column.patch.yml) replaces `ui-layout` with the service-line shell and adds [`vue2-echarts-content-poc`](../vue2-echarts-content-poc/README.md): charts in the conversation and the demo panel in the content column, from one Vue runtime.

`dsh --profile web --patch <path>` applies either one; the launcher's flags come first, so an app flag follows them:

```sh
pnpm dsh web --patch packages/experimental/vue2-echarts-tool-poc/overlay/show-chart.patch.yml --no-open
```

Both packages must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

## Configuration

| Field | Default | What it bounds |
| --- | --- | --- |
| `maxOptionBytes` | `65536` | Largest `option` a call may carry, as UTF-8 bytes of its JSON form. |
| `maxPoints` | `2000` | Largest total of `series[i].data` entries. The tool description states the configured value. |
| `verdictTimeoutMs` | `8000` | How long the call waits for a browser to report what it painted. |
| `screenshot` | `false` | Whether the painted chart is captured as a PNG and returned to the model as an image block. |

## The three feedback layers

A call passes through three gates, in order, and each one can end it.

**Bounds and supported types.** Before any browser is involved: the option's byte size, a non-empty `series`, every `series[i].type` in the supported set, and the total point count. A refusal costs one round trip, changes nothing, and names both the offending value and the correction.

**The render verdict.** The tool then blocks on the browser painting *this call id* — `exec.callId`, which is the same string the transcript hands the row through `ToolCallOwnerProps.callId`. ECharts reports its two outcomes on different channels, so the row does too: a document `setOption` throws on becomes `{ ok: false, error }` synchronously, and a document it accepts becomes `{ ok: true, seriesCount, pointCount }` on the first `finished` event after it. Settlement is single-shot: a second report for the same id, a report for a call that already timed out, and a report for a call this host never ran all answer `{ accepted: false }` and change nothing.

**The screenshot.** With `screenshot: true` the row also captures `chart.getDataURL({ pixelRatio: 1 })` and sends it with the verdict; the host commits it through the attachment service and appends an image block, the same lifecycle `read_image` uses. Bytes never ride the session log inline. A capture the store refuses is dropped and the verdict stands.

Until a verdict arrives the chart is laid out but invisible (`visibility: hidden`, because ECharts sizes its canvas from a laid-out element). A failure verdict replaces it with a one-line localized error carrying the engine's own message.

Both halves meet on two routes this package owns, `/show-chart/settings` (the capture switch, read once per boot) and `/show-chart/report` (the verdict).

## Trust

`option` is model output, rendered by a real engine inside the shell's own origin. It is not markup and it is not code — the host accepts only JSON — but three ECharts features turn plain JSON into a document the browser interprets, so the browser half rewrites exactly those three before painting ([`src/client/sanitize.ts`](src/client/sanitize.ts)):

- **`tooltip.renderMode` is forced to `richText`.** ECharts' default tooltip is HTML, and `tooltip.formatter` accepts a template string, so a model-supplied formatter would be a same-origin HTML injection. In rich-text mode the engine draws the tooltip on the canvas, where a tag is just characters.
- **`graphic` is dropped whole.** It renders arbitrary elements, including an `image` element pointing at any URL. A chart needs none of it.
- **Every `symbol`/`image` string starting with `image://` is dropped**, which is how ECharts loads a remote asset for a marker or a legend icon. Built-in symbol names are untouched.

Everything else passes through unchanged: a model writing ordinary ECharts is the point, and a sanitizer that rewrote the document would defeat it.

The report route accepts a verdict from anything that can reach the dsh origin, exactly as the rest of the HTTP API does. A report can only settle a call already waiting for one, and its worst outcome is a wrong verdict line on one chart the user is looking at.

## Model Experience

### The `show_chart` offer

#### What the model sees

One tool, `show_chart`, with an optional `title` string and a required `option` object whose `series` array is required. The description states the supported series types, the JSON-only rule, the configured point ceiling, that tooltips render as rich text, and that the UI picks the theme. This package contributes no system-prompt section.

#### Token effect

One fixed description plus the parameter schema, on every request where the tool is visible. The `option` schema is deliberately shallow — one object with one array — because the ECharts option format is something models already know; a typed per-chart schema would cost far more tokens and describe less.

#### KV Cache effect

The description is assembled once when the row loads and varies only with `maxPoints`, so the tool block stays byte-identical across requests within a deployment and the prefix holds.

### Tool-call result

#### What the model sees

A verified call answers `Rendered: <title or "chart"> — <n> series, <m> points`, and with `screenshot: true` also carries one image block that enters model context from the next request onward. A call no browser answered in time answers `Shown; not verified (no client reported within <s>s)` — not an error, because the chart is in the transcript either way and no browser may be open at all. A browser that could not paint the document answers `Error: Render failed: <the engine's own message>`, so the next call can be right. Each bound refusal answers `Error: show_chart: …` naming the offending value, the limit, and the correction.

#### Token effect

One short line per call. A screenshot adds one image, priced as an image on every subsequent request.

#### KV Cache effect

Append-only; results follow the reusable request prefix and invalidate nothing already cached.

## Known Limitations and Deferred Work

- **Three series types** — `bar`, `line`, and `pie`. The set is [`SUPPORTED_SERIES_TYPES`](../vue2-echarts-poc/src/chart-types.ts) in the component row, which registers exactly those ECharts modules; adding one is a constant plus a module entry, and the tool description and its refusals follow automatically.
- **JSON only** — the option crosses a tool-call boundary, so an ECharts feature expressed as a function (a `formatter` callback, a `symbolSize` function, a custom series renderer) cannot be sent at all.
- **The verdict comes from the first client that reports** — several browsers may show the same session, and whichever paints first answers the call. They are painting the same document, so the counts agree; a browser whose engine refused a document another accepted would not.
- **A screenshot needs a vision-capable model** — the image block enters context whether or not the route accepts images, and costs image tokens on every later request. It is off by default for both reasons.
- **The chart reads the palette once** — the row reads `body[data-ds-dark-theme]` when it mounts. A theme switch repaints the shell around a chart that keeps the palette it was built with, until the transcript remounts the row.
- **The report route assumes an HTTP carrier** — the browser half posts to `/show-chart/report` relative to the page origin. A transport that serves the shell without exposing the harness over HTTP would leave every call unverified.
- **No interaction reaches the model** — a click, a legend toggle, or a zoom stays in the browser. The agent can put a chart in front of the user; it cannot learn what the user did with it.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition, and the model-visible text is pinned verbatim in unit tests; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
