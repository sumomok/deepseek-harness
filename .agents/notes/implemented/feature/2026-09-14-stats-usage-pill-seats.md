# Agent Note: Contribution seats on the session token-usage pill

Status: implemented

English | [中文](2026-09-14-stats-usage-pill-seats.zh.md)

## Problem

The fork's balance plugin knows what a session cost in money. The place a reader looks for that is the token reading already under the composer, and nothing there could hold it.

`conversation.composer.dock` is a session-scoped list, and the dock stacks its entries in a column, so an occupant gets a row of its own under the stats pills rather than a place inside them. The `stats` entry that draws both pills declares no children, so the only way into the pill or its dialog is to reuse the `stats` id and shadow that entry wholesale — replacing the shipped time pill, usage pill, and both dialogs to append two figures. No plugin can open a seat from outside either, because a slot key is a `SlotMap` declaration merge owned by the package that renders the location.

## Decision

Two session-scoped child seats on the `stats` dock entry, both carrying `StatsUsageOwnerProps`.

`conversation.chat.stats.usageLabel` is a single slot taking the leading segment of the usage pill's label, where the shipped pill prints its abbreviated token total. The pill keeps everything after it: the aria-hidden `·` and the cache-hit segment still render, and the seat's fallback is that same token total, so an unoccupied pill is the shipped one.

`conversation.chat.stats.usageRows` is a list slot rendered inside the dialog's `dl[data-session-stats-usage]`, after the output row. An entry emits its own `dt`/`dd` pairs straight into that `dl` and inherits its skin; the framework wraps a slot entry in no DOM element of its own, so the pairs are real children of the list. With no entries the dialog is the shipped one.

Owner props are the two figures the pill itself computes: `totalTokens`, the exact whole-log sum of every prompt-side billing bucket plus output — not the abbreviated text the pill prints — and `cacheHitPercent`, the bare number the pill's own copy interpolates, or null when nothing has been billed. An occupant reads the session's billing without importing the chat implementation and without re-deriving a total from the projection.

The usage button loses its `aria-label`. It restated the two visible segments, and with a label occupant it would have kept announcing a token total no longer on screen. The accessible name now comes from the visible content, which is the shipped reading while the seat is empty. The separator between the segments is no longer `aria-hidden` and carries its own padding, so the rendered label spells out `105 tok · Cache hit 90%` — the string the `aria-label` used to hold, and the text the name is computed from.

The seats carry presentation only. The plugin owns what money means: its price table, its currency, its own copy and localization, and the decision of what to show while a model has no price. The chat package owns where those figures sit and what the pill reads when nobody contributes.

## Alternatives considered

**Shadow the `stats` dock entry and re-render both pills.** Rejected: the plugin would own the shipped time pill, usage pill, and both dialogs — every future upstream change to either pill would have to be re-implemented in the fork's plugin to stay visible.

**Register a second `conversation.composer.dock` entry.** Rejected by the requirement: the dock is a column, so a cost reading lands on its own row under the token reading rather than beside it, and the composer's bottom clearance grows for a figure that belongs in the existing row.

**Hand the seats the raw `TokenUsageProjection`.** Rejected: an occupant would re-derive the billed total and the cache-hit share, and the two readings in one pill could then disagree after any change to how the pill sums its buckets.

**Keep the `aria-label` and rebuild it from the occupant's text.** Rejected: an occupant renders React children, not a string, so the shell cannot read the rendered text back to compose a name; a name assembled from anything else would describe something other than what is on screen.

**One seat replacing the whole pill label.** Rejected: the cache-hit segment is shipped chrome with its own copy and locale, and an occupant that wanted to add a figure would have to re-render that segment to keep it.

## Consequences

A plugin adds a money reading to the token pill and a cost line to its dialog by registering two entries, with no fork of ui-chat and no replacement of shipped chrome. Both seats are empty in the shipped composition, so the generated client catalog lists them with no occupants and `replaceRisk: 'none'`, and the unoccupied pill and dialog are the shipped ones.

The shipped composition's button announces what it announced before: the `aria-label` held `105 tok · Cache hit 90%`, and the visible label now reads that same string, separator included. This is the one behavior change outside the seats themselves. The testing-library name computation trims each child's text alternative, so the spec asserts the unpadded `105 tok·Cache hit 90%`; the padding survives in the rendered label a browser computes its name from, and in the time pill's own `aria-label`, which the separator change leaves untouched.

**Retirement.** This is a fork overlay on an upstream client package. If upstream opens an equivalent contribution seat on the stats pill or its dialog — in any form, not only these keys — the overlay is retired and the fork's plugin adapts to upstream's form. Until then it is re-ported and re-verified on every rolling sync, because it lands in the pill markup and the slot contract upstream edits.

Package tests carry the evidence: both seats receive the exact totals, an unoccupied pill and dialog render exactly as before, a label occupant replaces the leading segment while the cache-hit segment stays, contributed rows land inside the dialog's `dl` after the output row despite the dialog being portalled to `document.body`, and the button's accessible name follows its visible content in both states.
