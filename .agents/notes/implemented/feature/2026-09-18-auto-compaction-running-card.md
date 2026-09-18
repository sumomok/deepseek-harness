# Agent Note: An open automatic compaction bracket owns a row

Status: implemented

English | [中文](2026-09-18-auto-compaction-running-card.zh.md)

## Problem

Automatic compaction summarizes a range of history and replaces it, and the model call that writes the summary takes seconds. Until the replacement lands, the transcript shows nothing at all: `compactionDefinition.buildViewNode` returned null while the bracket was open, so a person watching the conversation saw a pause with no cause. The same operation run by hand has shown `Compacting context…` from the moment `/compact` was typed, so one transaction was legible when a person asked for it and invisible when the engine started it.

The fork makes that gap the common case. The [automatic compaction policy seat](2026-09-14-auto-compaction-policy-seat.md) lets a deployment lower the trigger, and the accompanying plugin does, so an automatic bracket opens several times in a long session.

## Decision

`compactionDefinition` emits a third node kind. A Context that has its `compaction/start` Match, has no `compaction/end` Match, and has neither a landed checkpoint nor a recorded failure produces a visible `compaction-running` row, anchored at the start event's seq. The kind carries no payload: its copy is fixed and its render position is the node's `anchorSeq`, so there is nothing left for `data` to hold.

When the replacement lands, the same Context publishes the existing `compaction` marker at the checkpoint's seq instead. That marker already states `Compacted N history items (~X tokens)` from the `shadowedSeqs` and `shadowedTokenCount` the `compaction/summary` event carries, and still expands to the summary the backend wrote. Nothing on the landed path changed, so a historical bracket renders exactly as it did before. The node's `anchorSeq` moves from the start event's seq to the checkpoint's as that happens, and the transaction between the two appends no event another Definition renders, so nothing sorts into the gap and the row keeps its place.

The row is `CompactionItem` with a null node — the same element, icons, and stylesheet as the landed marker, with the running title and no summary segment beside it. The copy is the manual card's own `message.compaction.running`, and the visually hidden state announcement is the shared `row.running`; the change adds no locale key.

Both facts the row needs are Matches rather than State. The opening one is `context.start`, which the engine owns, so `bracketClosed` reads the closing `compaction/end` from `context.matches` beside it. State keeps carrying the summary, checkpoint, and failure evidence it already carried.

**Cancellation and abandonment.** A Stop closes the bracket with an abort-worded `compaction/end`. `failureReason` reads that wording as a cancellation and records no failure, so the row stops being shown — but it stops by publishing the same key with `visibility: 'hidden'`, not by returning null. The live tail builds keyed upserts and rejects a Definition that withdraws a target it already materialized, and the rejection throws before `flush` clears its dirty sets, which would freeze every later event out of the view. A bracket whose own step or turn closed while it was still open settles through the same hidden exit: `bracketAbandoned` reads the location status that the tool card's `interruption()` reads. A bracket that closes on a genuine error shows the failure notice, which takes priority over the running row.

**Windowing and an unclosed bracket.** A window that never loaded `compaction/start` has no State, and `fallbackState` derives its evidence from Matches alone; with no start Match there is no evidence a bracket is open, and no Context in that state ever published a node, so returning null withdraws nothing and such a window shows only a landed marker or a failure, as before. A log that ends inside an open bracket — a killed host, a machine that lost power — loses the row as soon as the enclosing turn closes, which is the same closing signal an unfinished tool call reads: agent-loop resume appends `turn/end` with an `interrupted` reason for a stored log whose last turn never ended, and session-query synthesizes one on a cold read. That holds for a bracket that has an enclosing turn, which is what `compactIfNeeded` opens with `owner: 'current-turn'` on its two triggers, step-boundary pressure and context-overflow recovery. A bracket opened outside any turn carries no such signal; the paragraph below states what that costs.

**Known limitation.** A bracket recorded outside any turn — `compaction/start` with `turn: null` — resolves to the `session` Location, and a Location that spans the whole session never closes, so its row survives any number of later turns and a cold reopen. This is the fork's main path into this Definition, not a corner of it: the bundled `auto-compact` plugin's end-of-turn compaction calls `compactNow(agent, signal)` with no `sourceCommandId` (`idle-compaction.ts:191`), which `compaction-basic` runs with `owner: null` and records as `turn: null`. A host killed during the seconds one of those brackets runs leaves one `Compacting context…` row in the reopened session permanently: with no turn to belong to it is neither a process member nor foldable, and its button is disabled, so a person has no way to clear it. The compaction lock itself is released — `assertCompactionInactive` passes once a `session/end-seed` sits above the unmatched start — so later compactions still run. That same `session/end-seed` boundary is the closing signal a Definition could read, but it is not among this Context's Matches.

`compaction-running` contributes nothing to the legacy conversation-node stream in `chat-snapshot-builder.ts`. It is registered there beside `turn-tail` and `system-prompt` as a known row that makes no contribution, so the switch's default case keeps its own meaning: a kind this build does not know.

**Retirement.** Retire when upstream renders anything at all for an open automatic compaction bracket, in any form. The mechanical check is `git grep -n compaction-running upstream/master`; zero hits means un-retired. Upstream through 0.1.6-alpha.2 returns null from `buildViewNode` unless a checkpoint landed, and its `CompactionItem` takes a non-null node. The port surface is the client-UI one the failure card already re-ports every rolling sync: `compaction.ts`, `CompactionItem.tsx`, `MessageItem.tsx`, `register-node-renderers.ts`, the generated `slot-catalog.ts`, and the package README pair.

## Alternatives considered

**Widen the `compaction` kind's payload to `CompactionSummaryNode | null`.** Rejected: `legacyContribution` in `chat-snapshot-builder.ts` pushes a `compaction` node's `data` straight into the legacy conversation-node stream, so a null payload would put a null node there. A separate kind is registered in that switch as a known row contributing nothing.

**Give the running kind a payload.** Rejected: the two candidates are already on the node — `id` is the `compactionId`, `anchorSeq` is the start seq — and the card shows neither.

**Track the closing `compaction/end` in State beside the failure Match.** Rejected: the other half of the same fact is the engine-owned start Match, so the pair would be split across State and Context, and the windowed path would carry a field it never consults.

**Render the open bracket with `GenericCommandCard`, the way the manual card does.** Rejected: there is no command, so the card has no name for its title and no settlement text for its summary, and the row would not become the landed marker that replaces it.

**Have automatic compaction write a `command/run` and reuse the manual path entirely.** Rejected: a command event asserts that a person ran a command, and the session log would then record an act nobody performed.

**Show the trigger reason or the context-pressure ratio on the row.** Rejected: the row states what is happening. Why the engine started is a policy fact with no bearing on what a person can do about it.

## Consequences

An automatic compaction is legible for its whole lifetime: running, then compacted with its counts, or replaced by the failure notice, or gone when a Stop cancelled it. A transcript gains one row while a bracket is open, and a settled bracket keeps a hidden node for its key, which costs one store entry and no render. Each compaction is its own Context, so a summarizer that stays down across several steps leaves several rows, which the failure card's note already records as a known limitation.

## Testing

`packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` pins the Definition: a row while the bracket is open, a row that survives the written summary until the checkpoint lands, the landed marker with its counts replacing it, a hidden row after a cancellation, no row after an error, a visible row inside an open turn, a hidden row once that turn closes without the bracket, no row for a window without the start, and a manual bracket left to the command card. A `live` helper drives `append` followed by `flush`, the path whole-window replay never takes, and pins the cancellation, the landing, and the failure on the live tail; the cancellation case asserts that the following user message still renders. `packages/client/ui-chat/tests/compaction-running-row.client.spec.tsx` pins the row itself in both languages, its disabled non-expandable button, the hidden running announcement, and the landed marker's unchanged counts and disclosure.
