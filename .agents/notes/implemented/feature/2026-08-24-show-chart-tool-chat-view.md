# Agent Note: `show_chart` — a chart the agent draws in the conversation, and the browser's answer back

Status: implemented

English | [中文](2026-08-24-show-chart-tool-chat-view.zh.md)

## Problem

[The Vue 2.7 bridge](2026-08-24-vue2-bridge-echarts-poc.md) proved a foreign framework can live in a React slot, and put a chart in the service-line shell's `content` column. Two things were still missing.

The column exists on this product branch alone, so nothing built against it can merge. The conversation transcript is the surface both shells share.

And the chart was demo data. A chart the agent draws is model output rendered by a real engine inside the shell's own origin, and the model gets nothing back: no confirmation that anything painted, no way to correct a document the engine refused, and no picture. A tool whose only feedback is "the call returned" cannot be iterated on by the thing calling it.

## Decision

One package, `vue2-echarts-tool-poc`, offering `show_chart` and claiming the `show_chart` key of the transcript's `tool.call.toolview` slot. The components stay in `vue2-echarts-poc`, requested through `dsh.client.external`.

### The option passes through; the supported set has one home

`show_chart` takes a complete ECharts option as JSON. Models already know the format, so a typed per-chart schema would cost more tokens and describe less; the parameter schema is one object with a required `series` array, and everything else the model needs is in the description.

What the description promises is `SUPPORTED_SERIES_TYPES` — `bar`, `line`, `pie` — declared in the component row's `src/chart-types.ts`, a module that imports nothing. The client derives its `echarts.use` registration from it through a keyed module table, so a fourth type fails the build until its ECharts module is named beside it; the host imports the same constant from the package root, so a refusal names exactly what the browser cannot paint. `countSeriesPoints` lives there too: the host's point ceiling and the browser's verdict count the same way.

### A keyed tool view, not a column

`tool.call.toolview` is keyed by wire tool name and open, so claiming this package's own tool is additive — every other row keeps what it had. The key belongs to the shipped conversation, which both shells mount, so the same package works under the official layout and under the service-line one. Two overlays ship exactly that: one that leaves `ui-layout` in place, one that replaces it and adds the content-column placement, proving both placements share one Vue runtime.

### The verdict round trip, and hidden until verified

The tool body blocks on the browser painting *this call id*. `exec.callId` is the identity the tool execution carries, and `ToolCallOwnerProps.callId` is the same string the transcript hands the row — one table keyed by it settles the wait.

ECharts reports its two outcomes on different channels, so the component does too: `setOption` throws synchronously on a document it refuses, which is the failure verdict, and a document it accepts paints asynchronously, so the success verdict waits for the first `finished` event after it. Settlement is single-shot: the entry is removed before its waiter resolves, so a second report, a report for a call that already timed out, and a report for a call this host never ran are all the same answer — nothing was waiting.

The chart is laid out but invisible until a verdict says it painted. `visibility`, not `display`: ECharts sizes its canvas from a laid-out element, and a display-hidden host would hand it a zero-sized one — the verdict would then be about a chart nobody sees.

A timeout is not an error. The chart is in the transcript either way and no browser may be open at all, so the call answers `Shown; not verified`; only a refused document is a tool error, carrying the engine's own message so the retry can be right.

### The screenshot is opt-in

`screenshot: true` adds one `getDataURL` read, delivered through `onCapture` just ahead of the verdict so the row sends both in one message; the host commits it through the attachment service and appends an image block, the same lifecycle `read_image` uses. Off by default: it needs a vision-capable model and costs image tokens on every later request.

### The sanitizer rewrites three things

The option is model output painted same-origin with the shell. It is not markup and not code — the host accepts only JSON — but three ECharts features turn plain JSON into a document the browser interprets: an HTML tooltip whose `formatter` accepts a template string, `graphic` elements pointing at any URL, and `image://` asset references on symbols and legend icons. The browser half forces `tooltip.renderMode: 'richText'`, drops `graphic`, and drops those asset strings. Everything else passes through: a model writing ordinary ECharts is the point.

## Alternatives considered

**A typed per-chart schema** (`{ kind: 'bar', categories, series }` and friends). Rejected: it costs far more schema tokens, describes a fraction of what ECharts does, and needs a new schema arm plus a new mapper for every chart shape. The pass-through option is a format the model already writes, and the supported-set check plus the render verdict cover what a schema would have caught — later and with a real engine's own message.

**A plugin-owned Typert remote namespace** for the verdict, which is how a host capability normally reaches the browser. Not available to this package: the workspace Typert generator discovers Host-face contributors from `tsconfig.host.json` references (`typertPlugin({ mode: 'workspace', faces: ['host'] })` in the root tsdown config), and a two-entry client plugin registers in `tsconfig.client.json` — exactly one aggregate, with `api/remotes` the only sanctioned split. The two halves therefore meet on two webserver routes this package owns, the mechanism `content-frame` already uses for its settings document. The settings route answers the same question a `settings()` remote method would, one GET per boot, and the report route is a POST with a bounded body; a remote namespace would have added a generated artifact and a BFF assembly edit for the same two messages.

**A model-judged reveal** — show the chart immediately and let the model decide from the result whether it worked. Rejected: the user sees a broken or empty chart before the model can react, and the model has nothing to judge from except the arguments it already sent.

**HTML tooltips with escaping.** Rejected: `tooltip.formatter` is a template the engine expands, so escaping would have to understand ECharts' own placeholder grammar to be correct. Rich text moves the tooltip onto the canvas, where markup is not a category the renderer has.

**Rendering the chart server-side and returning only an image.** Rejected for this line: it gives up the live chart the user can hover and resize, needs a headless renderer in the host process, and still cannot tell the model whether the browser could paint it. The screenshot rides *beside* the live chart instead.

## Consequences

`show_chart` is `develop`-mergeable: no dependency on the service-line shell, and the overlay that composes it leaves the shipped layout alone.

The component row now exports a second chart. `EChartsBar` and `EChartsOptionChart` share `echarts-host.ts` — the module registration derived from the supported set, the two palettes, and the instance lifecycle (`attachChart`: build on the current palette, rebuild on a palette change because ECharts resolves a theme only at construction, resize with the element, dispose on unmount). `EChartsBar` keeps its own component: its Vue-owned click counter is the bridge's proof, and rebuilding it on the pass-through chart would delete that evidence to save a dozen lines.

A row that hands the chart a freshly sanitized object on every render would make the chart re-apply, re-report, and re-render without end; the sanitized option is memoized on the raw argument string, which is the row's one piece of derived state besides the verdict.

The tool bundle is 13 kB raw and 5 kB gzipped, carrying neither Vue nor ECharts: the manifest's `dsh.client.external` keeps the component row an import resolved through the loader's module table, which is also what keeps one Vue runtime in the graph.

## Testing

`echarts-option.client.spec.tsx` drives the pass-through chart over a fake engine: what reaches `setOption`, both verdict edges, the stray `finished` that reports nothing, re-application on a React commit, the capture switch, and the palette rebuild. `chart-types.client.spec.ts` pins the supported set and the point counter.

`show-chart-tool.client.spec.ts` runs the tool through the real tool registry with a fake reporter: the description, the parameter schema and every result line verbatim, each bound refusal, the ok/error/timeout verdicts, a duplicate report and an unknown id both ignored, cancellation, and the screenshot with and without a mounted store — including the correlation assertion, that a verdict under any id but the execution's own reaches no call. `show-chart-routes.client.spec.ts` boots a test-only cordis.yml through the real Loader and reads the served HTTP surface: the settings document, a posted verdict settling a live call, the refusals a malformed or oversized body gets, method gating, and route release on fiber disposal.

`sanitize.client.spec.ts` pins the three rewrites and that nothing else moves. `show-chart-row.client.spec.tsx` drives the row over a recorded chart: the running and settled slices, the sanitized option's stable identity, hidden-until-verified, the error row, one report per call id, and the capture switch. `browser-plugin.client.spec.ts` proves the keyed claim, the injected capture switch, the loud failure on an unusable settings document, and removal on fiber teardown.

`apps/web/tests/show-chart.e2e.ts` boots both overlays against the real Web composition with a seeded log carrying two settled calls, and asserts a sized canvas inside each call's own transcript row plus, under the service-line shell, the content column's panel beside them. The live await path — a tool body blocked on a browser verdict — is covered by the host specs with a fake reporter; a keyless replay lane runs no model and therefore issues no live call.
