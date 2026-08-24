# Agent Note: `show_chart` — one chart across calls, and a screenshot the model actually reads

Status: implemented

English | [中文](2026-08-24-show-chart-supersede-and-inspection.zh.md)

## Problem

[`show_chart`](2026-08-24-show-chart-tool-chat-view.md) closed the loop mechanically: the browser paints, the verdict comes back, and with `screenshot: true` a PNG rides along. A real session with screenshots on showed the loop is not closed in the model's head.

The result text said `Rendered: … — 2 series, 14 points` and the PNG was attached. The model's next thought was that the chart had rendered and it should summarize. It never looked at the picture. The verdict line had already declared success, and nothing in the result asked for anything else — the same model inspects an image carefully when told to.

A second call answered `Shown; not verified (no client reported within 8s)` because the browser tab was backgrounded, which throttles `requestAnimationFrame`, which means no `finished` event before the deadline. The model read that as a failure and re-issued the identical chart, so the user got a duplicate row under a chart that was already on screen.

Both of those are text problems. A third finding is structural: the model reached the tool through Code Mode, so the log carried `tool/code-dispatch-start` / `tool/code-dispatch` with `name`, decoded `arguments`, and a `subCallId` like `<root>:code:1` — no top-level `tool/call` at all. Anything that folds chart calls out of the log has to recognize both shapes or it sees nothing for such a session.

A fourth is smaller: a user asked for a radar chart, and layer one correctly refused, listing `bar, line, pie`.

## Decision

### The result text asks for the next step

A screenshot now arrives with a sentence: inspect it for overlapping legends, labels, or axes and clipped text, and call `show_chart` again with a corrected option under the same id if any. It rides as a **second text block**, not appended to the verdict line, so the settled call card — titled from the first text block — stays one short line.

The unverified line keeps its first sentence and gains a second: the chart is in the transcript and paints when the user views it, so do not re-issue it. `Shown; not verified` was already not an error; what was missing was the instruction that follows from that.

The description now states the size of the surface the chart lands in — roughly 500×340 CSS pixels — and asks for a bottom legend and ECharts' own layout rather than absolute `grid` offsets. Model-supplied `grid` offsets were the recurring cause of the layout faults the screenshot instruction now asks about.

### `id` names a chart; the newer call replaces the older row

`show_chart` takes an optional `id`: trimmed, non-empty, at most 64 characters. Reusing an earlier chart's id means this call replaces that chart. A call naming no id is its own chart, keyed by its call id, and supersedes nothing.

Both calls stay in the transcript — the log is what happened, and no row edits another. The older row collapses to a one-line localized notice: no canvas, no ECharts instance, and no verdict report, because the call it would answer settled long ago.

The mechanism does not make the model reach for it. In a session with a chart already on screen, the user quoted its caption and asked for a bar series alongside the line; the model minted `gold-7d-change` beside the existing `gold-7d` and drew a second chart, where the user expected the one they were pointing at to change. The same model, in the same session, reused an id unprompted when the screenshot instruction asked it to — so the mechanism was reachable and only the trigger was missing. The `id` description now names that trigger: a request to change, extend, or fix a chart already drawn — quoted, named by its title, or otherwise pointed at — carries that chart's own id, because a new id draws a second chart beside the old one. Only a genuinely new chart gets a new id.

That clause is one of two layers. [The content-surface rule](2026-08-24-content-on-display-rule.md) states the same thing for every content tool, in the system prompt and without chart vocabulary; the two were measured against this session together, and the clause alone recovers half of the failures while the pair recovers all of them.

### The `showCharts` projection is what a row cannot see for itself

A row renders one call slice. Deciding whether a later call took its chart id requires reading the calls after it, which no row can do. The node half projects it instead, through the session-projection seam: `showCharts` folds the log into `entries` — one `{ chartId, callId, title, seq }` per recorded chart call, in log order — and the view derives `latest`, the call currently owning each chart id.

The fold reads both log shapes: `tool/call` (raw-JSON `arguments`, `callId`) and `tool/code-dispatch-start` (decoded `arguments`, `subCallId`). Arguments neither half could draw a chart from contribute nothing, which is why the argument reader is one module — `src/chart-call.ts`, imported by the host fold and by the browser row. A call the projection counted but the row cannot draw would blank a chart the user is still looking at; one the row draws but the projection never counted could never be superseded.

The browser row reads the value through `useProjection`, the framework's fifth standard hook seat, delivered to every session-scope slot component — `tool.call.toolview` is one. No subscription, no store, no second table. An absent value is not a superseded row: the projection lags its log by a frame, and a composition without a projection registry publishes nothing at all.

`entries` is deliberately more than supersede needs. A later content surface listing a session's charts reads exactly this value; `latest` is the derived view supersede happens to want.

### radar

`SUPPORTED_SERIES_TYPES` gains `radar`, its chart module lands in the keyed `SERIES_MODULES` table, and `RadarComponent` joins the shared component list — a radar series is drawn on a coordinate system its chart module does not carry. The tool description and every refusal name the set from that one constant, so they followed on their own.

### Legibility and room

Captures are read at `pixelRatio: 2`. At the column's CSS size a one-to-one raster leaves axis labels and legend entries unreadable, which makes an instruction to inspect the picture pointless. The route's body bound is derived from the attachment store's own `maxImageBytes`, so it already accommodates the larger PNG. The stage grew from 280 to 340 px, which is the height the description promises.

## Alternatives considered

**Mutate the older row's arguments, or drop its events.** Rejected: the session log is what happened, and every projection, replay, and SDK consumer reads it. Supersede is a render decision over an append-only log, computed fresh on every replay.

**Give the older row nothing at all — render it empty or hide it.** Rejected: the user saw that chart and asked about it; a row that vanishes reads as a bug. The notice names the chart and says it was updated.

**Raise `verdictTimeoutMs` instead of writing the sentence.** Rejected: a backgrounded tab is throttled indefinitely, so no finite deadline fixes it, and a longer one makes every genuinely unverified call block longer. The deadline is a bound on waiting; what the model does afterwards is the text's job.

**Have the model judge from the arguments whether the chart is worth showing.** Rejected here as it was for the reveal: the model has nothing to judge from except the option it just wrote. The screenshot is the only evidence of what was actually painted, which is why the instruction points at it.

**Let the row read the session window and find later calls itself.** Rejected: it would be a business fold inside a presentation component, re-run per row, over a window that is not guaranteed to hold the whole log. The projection is the sanctioned computation site and is folded once per session.

**A second, browser-side table of chart ids.** Rejected: the projection value already is that table, and a client-side copy would need its own invalidation and would disagree with replay.

## Consequences

The projection is the first half of a content surface. `entries` carries what a chart list needs — ids, captions, log order — so a later feature reads one already-driven value instead of introducing a second fold over the same events.

The package now depends on the session-projection seam, but only optionally: `ctx.inject(['sessionProjections'], …)` means a composition without a registry keeps the tool, the routes, and every row, with each chart being the call that drew it.

The projection grows with the session's chart calls and carries each caption verbatim. Both are bounded only by the log itself; nothing trims them today, and the package README records it.

The model is never told that a chart was superseded. The older call's result is whatever it was when the call settled, and nothing revisits it — a supersede is a render decision, and reaching back into a settled result would be a second source of truth about a call.

The component row's bundle grew with `radar`: 1.50 MB raw, 342 kB gzipped, up from 1.47 MB / 337 kB. The tool bundle is 16 kB raw, 6 kB gzipped, still carrying neither Vue nor ECharts.

## Testing

`show-charts-projection.client.spec.ts` drives the unit over the real registry and a real session: both log shapes, the explicit id and the call-id fallback, whitespace normalized to one chart, last call wins across shapes, the log seq each entry carries, every argument form that must contribute nothing, another tool's calls, and removal on fiber disposal. `show-chart-routes.client.spec.ts` boots the unit through the real Loader alongside the routes and the tool, and reads the projected value off a session it appended to.

`show-chart-tool.client.spec.ts` pins every model-visible string verbatim: the description including the column size, the parameter schema with `id` and its reuse trigger, both id refusals and the order that puts the id fault first, the extended unverified line, and the screenshot instruction as its own text block — present only with a stored capture, and never in the settled card's title. `validate.client.spec.ts` pins the id rules at both edges of the length ceiling and the supported set now naming radar.

`show-chart-row.client.spec.tsx` drives the row over a recorded chart and a stubbed projection seat: the superseded row renders the notice, mounts no chart, and posts no report; the owning call draws; and an absent value, an unrelated chart id, and a call that is its own chart all draw. `echarts-option.client.spec.tsx` pins the capture's `pixelRatio: 2` and paints a radar option through the fake engine.

`apps/web/tests/show-chart.e2e.ts` seeds four settled calls into a real composition — two id-less, then two sharing `id: 'demo'` with different options — and asserts, under both the shipped layout and the service-line shell, that the older `demo` row shows the notice with no canvas anywhere inside it while the newer one paints a sized canvas. The newer one is a radar chart, so the real bundle's module registration is covered by the same assertion.
