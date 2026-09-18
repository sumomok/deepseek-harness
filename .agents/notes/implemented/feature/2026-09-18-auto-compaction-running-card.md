# Agent Note: An open automatic compaction bracket owns a row

Status: implemented

English | [中文](2026-09-18-auto-compaction-running-card.zh.md)

## Problem

Automatic compaction summarizes a range of history and replaces it, and the model call that writes the summary takes seconds. Until the replacement lands, the transcript shows nothing at all: `compactionDefinition.buildViewNode` returned null while the bracket was open, so a person watching the conversation saw a pause with no cause. The same operation run by hand has shown `Compacting context…` from the moment `/compact` was typed, so one transaction was legible when a person asked for it and invisible when the engine started it.

The fork makes that gap the common case. The [automatic compaction policy seat](2026-09-14-auto-compaction-policy-seat.md) lets a deployment lower the trigger, and the accompanying plugin does, so an automatic bracket opens several times in a long session.

## Decision

`compactionDefinition` emits a third node kind. A Context that has its `compaction/start` Match, has no `compaction/end` Match, and has neither a landed checkpoint nor a recorded failure produces `compaction-running`, anchored at the start event's seq. The kind carries no payload: its copy is fixed and its render position is the node's `anchorSeq`, so there is nothing left for `data` to hold.

When the replacement lands, the same Context publishes the existing `compaction` marker at the checkpoint's seq instead. That marker already states `Compacted N history items (~X tokens)` from the `shadowedSeqs` and `shadowedTokenCount` the `compaction/summary` event carries, and still expands to the summary the backend wrote. Nothing on the landed path changed, so a historical bracket renders exactly as it did before.

The row is `CompactionItem` with a null node — the same element, icons, and stylesheet as the landed marker, with the running title and no summary segment beside it. The copy is the manual card's own `message.compaction.running`, and the visually hidden state announcement is the shared `row.running`; the change adds no locale key.

Both facts the row needs are Matches rather than State. The opening one is `context.start`, which the engine owns, so `bracketClosed` reads the closing `compaction/end` from `context.matches` beside it. State keeps carrying the summary, checkpoint, and failure evidence it already carried.

**Cancellation.** A Stop closes the bracket with an abort-worded `compaction/end`. `failureReason` reads that wording as a cancellation and records no failure, and the running row is gated on the absence of any `compaction/end`, so the row disappears with the bracket instead of outliving it. A bracket that closes on a genuine error shows the failure notice, which takes priority over the running row.

**Windowing and an unclosed bracket.** A window that never loaded `compaction/start` has no State, and `fallbackState` derives its evidence from Matches alone; with no start Match there is no evidence a bracket is open, so such a window shows only a landed marker or a failure, as before. A log that ends inside an open bracket — a killed host, a machine that lost power — keeps the running row on reload. The bracket genuinely never closed, and the row states that rather than inventing an outcome; an unfinished tool call reads the same way.

`compaction-running` contributes nothing to the legacy conversation-node stream in `chat-snapshot-builder.ts`, which is what its documented default case does for every kind that is not a durable transcript node.

**Retirement.** Retire when upstream renders anything at all for an open automatic compaction bracket, in any form. The mechanical check is `git grep -n compaction-running upstream/master`; zero hits means un-retired. Upstream through 0.1.6-alpha.2 returns null from `buildViewNode` unless a checkpoint landed, and its `CompactionItem` takes a non-null node. The port surface is the client-UI one the failure card already re-ports every rolling sync: `compaction.ts`, `CompactionItem.tsx`, `MessageItem.tsx`, `register-node-renderers.ts`, the generated `slot-catalog.ts`, and the package README pair.

## Alternatives considered

**Widen the `compaction` kind's payload to `CompactionSummaryNode | null`.** Rejected: `legacyContribution` in `chat-snapshot-builder.ts` pushes a `compaction` node's `data` straight into the legacy conversation-node stream, so a null payload would put a null node there. A separate kind falls through that switch's documented default and contributes nothing.

**Give the running kind a payload.** Rejected: the two candidates are already on the node — `id` is the `compactionId`, `anchorSeq` is the start seq — and the card shows neither.

**Track the closing `compaction/end` in State beside the failure Match.** Rejected: the other half of the same fact is the engine-owned start Match, so the pair would be split across State and Context, and the windowed path would carry a field it never consults.

**Render the open bracket with `GenericCommandCard`, the way the manual card does.** Rejected: there is no command, so the card has no name for its title and no settlement text for its summary, and the row would not become the landed marker that replaces it.

**Have automatic compaction write a `command/run` and reuse the manual path entirely.** Rejected: a command event asserts that a person ran a command, and the session log would then record an act nobody performed.

**Show the trigger reason or the context-pressure ratio on the row.** Rejected: the row states what is happening. Why the engine started is a policy fact with no bearing on what a person can do about it.

## Consequences

An automatic compaction is legible for its whole lifetime: running, then compacted with its counts, or replaced by the failure notice, or gone when a Stop cancelled it. A transcript gains one row while a bracket is open, and a session whose log ends inside an open bracket keeps a row that never resolves. Each compaction is its own Context, so a summarizer that stays down across several steps leaves several rows, which the failure card's note already records as a known limitation.

## Testing

`packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` pins the Definition: a row while the bracket is open, a row that survives the written summary until the checkpoint lands, the landed marker with its counts replacing it, no row after a cancellation, no row after an error, a row kept for a bracket the log never closed, no row for a window without the start, and a manual bracket left to the command card. `packages/client/ui-chat/tests/compaction-running-row.client.spec.tsx` pins the row itself in both languages, its disabled non-expandable button, the hidden running announcement, and the landed marker's unchanged counts and disclosure.
