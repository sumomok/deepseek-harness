# Agent Note: Beside a content column, the chart row keeps the verdict and gives up the picture

Status: implemented

English | [中文](2026-08-24-chart-row-compacts-beside-the-column.zh.md)

## Problem

[The content surface](2026-08-24-content-surface-router.md) gave `show_chart` a second placement, and a session with a content column then drew every chart twice: full height in the column, and full height again where the call sits in the conversation. The conversation is the expensive copy — one 340px stage per call, stacked, in the narrower of the two columns, and the one the user scrolls — and it is showing what the column beside it already shows.

Not rendering there is not an option on its own. [The transcript row](2026-08-24-show-chart-tool-chat-view.md) is the only owner of the render verdict and the screenshot: the tool body blocks on *this call id* being painted, and the column's `chart` seat deliberately answers nothing, because the call it would answer settled long ago and a chart the user merely selected again would report a second time about nothing.

## Decision

Where a content column is composed, the transcript row hands over the picture and keeps the verdict. This reverses the "the chart is the transcript row" half of [the `show_chart` decision](2026-08-24-show-chart-tool-chat-view.md); nothing about who owns the verdict, the capture, or the report moves.

**The row senses the column through the `contentSurface` projection.** A value means a content column is composed, which by construction means this session's charts are entries in it: the column's `chart` extractor and the transcript row read the same events through the same reader, so every chart the row would draw is already a row in the switcher. No value — the shipped layout, or any composition without the surface — and the row behaves exactly as it did.

**Three states, and two exemptions.** While the call waits for its verdict the row shows `<title>: drawing…` and mounts the engine off the layout flow; once the verdict is in it shows `<title>: shown in the content panel.` and unmounts the engine. A **superseded** row keeps its own notice ahead of either, because it answers no call and mounts no engine under any layout. A **failed** chart keeps the localized error line in the conversation, because a document that did not paint is not in the column either, and the message is what the next call needs.

**Off the flow, not out of layout.** The waiting stage is `position: fixed` at a fixed size, off to the side. ECharts sizes its canvas from a laid-out element, so `display: none` would hand it a zero-sized one and the verdict would be about nothing — the same reason the shipped stage hides with `visibility`. Fixed positioning adds what `visibility` alone cannot: the conversation spends no height on it.

## Alternatives considered

**Move the verdict to the column's `chart` seat and let the transcript row disappear.** Rejected: the seat draws the *selected* entry only, so a chart the user never selects would never be verified and the tool would time out on a chart that painted fine, while a re-selected one would report twice. Verdict ownership follows the call, and the call sits in the transcript.

**Match per entry — compact only the rows whose chart is actually in the column.** Rejected as a lookup that cannot change an outcome: both sides derive their entries from the same events through the same reader, so a current chart always has an entry, and a superseded one is already exempt. It would also make the row depend on the column's entry vocabulary rather than on whether a column exists at all.

**Keep the compact card and skip the engine, accepting `Shown; not verified`.** Rejected: it silently drops the second and third feedback layers for every deployment that opens a column — no confirmation that the document painted, no engine message on a document it refused, and no screenshot — which is most of what the tool is.

**A `Config` field choosing the placement.** Rejected: the choice is already expressed, and expressed better, by the composition. A deployment that wants the chart in the conversation composes no content column; one that composes a column has said where content goes. A field would let the two disagree.

**Make the compact card select its chart in the column.** Deferred, not rejected: the two components live in different packages with no channel between them, and a slot component may not subscribe to anything of its own. It is recorded as a limitation in the package README rather than built through a global the column would have to publish.

## Consequences

The shipped layout is untouched, and the evidence is that `apps/web/tests/show-chart.e2e.ts`'s shipped-layout scenario asserts the same painted canvases it always did, unedited. Its service-line scenario changed with the behavior: it now asserts the compact card, no canvas in the conversation, and no stage left in the chat column.

`apps/web/tests/content-surface.e2e.ts` carries the proof that the round trip survived the collapse. It watches `/show-chart/report` from the browser and asserts that exactly the two current charts posted a verdict and the superseded row posted none — evidence the compact card alone cannot give, since the card and the report are two consequences of the same verdict.

A compact row still builds one ECharts instance and disposes it on the verdict. That is the price of keeping ownership where the call is; a transcript replayed with hundreds of charts pays it per row as the row scrolls into view.

Two dictionary keys (`row.delegating`, `row.delegated`) and one attribute (`data-show-chart-delegated`, `pending` then `shown`) are new. The card reuses the superseded card's styling, because both say the same thing to the reader: the chart this call drew is somewhere else now.

## Testing

`show-chart-row.client.spec.tsx` drives the row over both compositions: the compact card in each of its two states, the off-flow stage class and the engine behind it, the engine gone once the verdict is in with the capture still riding along, the failure that stays in the conversation, the superseded row that takes precedence, and — the `develop` half of the contract — a row that keeps the whole chart when no `contentSurface` value exists.
