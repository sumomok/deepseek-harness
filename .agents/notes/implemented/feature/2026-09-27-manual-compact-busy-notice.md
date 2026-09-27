# Agent Note: A manual `/compact` during a reply waits for the boundary a setting chooses

Status: implemented

English | [中文](2026-09-27-manual-compact-busy-notice.zh.md)

## Problem

A user typed `/compact` while a reply was running and reported that nothing happened. The Host runs manual compaction through `compactNow`, which calls `agent.runMaintenance` and throws `busy` unless the agent is idle, so the command settled as a failed `/compact` card. That card was a `manual-compaction` node inside the running Turn, and the `compact` and `standard` work-details modes fold process groups even while a Turn runs, so the card was hidden. Once the Turn completed, the whole-Turn fold hid it again. The [automatic compaction running row](2026-09-18-auto-compaction-running-card.md) had already been taken out of the group; the manual card had not.

The user decided on 09-27 that a busy `/compact` is not refused: a Settings → General row, 「繁忙时的压缩行为」 ("Compaction while busy"), chooses whether it runs at the running Turn's next step boundary (「立即打断」, Interrupt) or right after the Turn ends (「排队等候」, Queue), and compaction rows stay visible after the Turn folds.

## Decision

**The engine waits instead of refusing.** `CompactionEngine.compactNow` takes an optional `whileBusy: 'next-step' | 'turn-end'`. For an idle agent, or without it, nothing changes. For a running agent, `dsh-compaction-basic` keeps one waiting request per Session. Its `agent/pre-step` listener serves `next-step` at the next step boundary, with a bracket the open Turn owns — the same place and ownership as automatic pressure compaction, so the Turn continues on the replacement surface and is not cancelled. `turn-end` is served after a non-aborted `turn/end`: at the first step boundary of a Turn the loop chains from its inbox without going idle, or in the `agent/status` idle transition as ordinary idle maintenance with a standalone bracket. A `next-step` request whose Turn ends without another boundary — the reply was already the final step — is served the same way. A `turn-end` request that arrives after a `turn/end` or `turn/start` but before that Turn's first `step/start` — while a chained Turn assembles its system prompt — is due at once and served at that first step boundary; the listener tracks `turn/start`, `step/start`, and `turn/end` per Session to know this, since otherwise such a request would wait for the chained Turn to end. The idle listener starts `runMaintenance` synchronously, so a queued prompt latches behind the maintenance instead of opening the next Turn first. An aborted `turn/end` (Stop), the request's own signal, and engine disposal cancel the wait; a second request while one waits is `busy`. These listeners do not depend on `auto`: they only run what a person asked for.

**The choice is a live Host-plane service.** `@deepseek-ai/dsh-compaction` declares `ctx.manualCompactionTiming` with `whileBusy()`. `ui-chat`'s Host plugin owns the setting as the volatile `ui-chat.busyCompaction` field and provides the service; `command-compact` reads it once per request and passes the answer to `compactNow`. `command-compact` is mounted once per preset, so it cannot own a uniquely addressed Settings form; `ui-chat` can, and it already owns the `/compact` card. This follows `compactionPolicy`: a Host-plane provider that the preset realm reads through `ctx.get`. Without a provider — TUI, ACP, headless compositions — a busy `/compact` is still refused, as upstream does.

**Queue is the default.** Like a queued message, the running Turn finishes on the history it started with, and Queue is already the busy-Enter default. Interrupt replaces the Turn's own tool results with the summary mid-Turn, which a person should opt into.

**Manual compaction keeps its retention of zero at a step boundary.** The in-Turn request selects the same range an idle `/compact` would, retaining only the last node and a balanced tool pair. Using the automatic retained tail instead would make one command mean two different reductions depending on timing.

**The composer refusal is removed.** Under the setting both choices accept a busy `/compact`, so the `commandUi` decoration that consumed the command and raised `A reply is in progress. Compact after this turn ends.` has nothing left to refuse. Its module, tests, locale key, web scenario, and the `ui-commands` dependency are gone.

**The card shows its waiting state and speaks the reader's language.** The command Definition folds a correlated `compaction/start`; until one arrives an unsettled `/compact` card reads `等待压缩…` / `Waiting to compact…`, then `正在压缩…`. The Host's fixed English result texts are exported from the cordis-free `@deepseek-ai/dsh-command-compact/result-text` leaf; the client bundle may not import that value, so `chat/compact-result.ts` restates the table and `satisfies typeof COMPACT_RESULT_TEXT` fails the build when a Host text changes.

**Compaction rows stay outside both folds.** `process-groups.ts` lists `manual-compaction` among the independent roots, and `contract/turn-process.ts` lists it among the kinds that stay outside a completed Turn's whole-Turn fold. The automatic failure row gets the same two entries through `auto-compaction-policy-seat`.

**Why this is a core patch.** The engine listeners, the Service Definition, and the consumer live in upstream packages, and the fold sets are constants inside `ui-chat`. Whatever provides the timing must ship on both the desktop and the console line; a package outside this repository reaches only the desktop.

## Alternatives considered

**Keep refusing in the composer.** Superseded by the 09-27 decision; it also leaves the user to retype the command after the Turn.

**Queue the command in a Host-side command queue.** Rejected: it would need a new durable record, while the engine already has the step and idle boundaries and the command lifecycle (`command/run` … `command/done`) records the wait.

**Have the client hold `/compact` until the Turn ends.** Rejected: Interrupt cannot be done from the client, and a chained queued Turn never shows the client an idle state.

**Extend `CompactionPolicy`.** Rejected: the desktop's auto-compact plugin is its sole provider, and it would have to implement a setting it does not own.

## Consequences

A waiting request keeps its `commands/execute` call open; closing the invoking page cancels it, and the card settles as cancelled. Interrupt compacts with a bracket owned by the Turn, so the card sits inside that Turn; Queue's card moves to after the Turn once its standalone bracket lands, or into the next Turn when a queued prompt follows without an idle gap. A `/compact` from a composition with no provider still gets the `busy` card, now localized.

**Retirement.** The engine and consumer part retires when upstream lets a busy `/compact` wait or otherwise changes the `busy` branch of `compactNow` or `command-compact`. The fold entries retire when upstream keeps an in-Turn `manual-compaction` visible in both folds. The ledger entry `manual-compact-busy-notice` in `.claude/core-patches.md` carries the mechanical checks.

## Testing

`compaction-basic/tests/manual-compaction-while-busy.spec.ts` drives the real loop: next-step inside the Turn, next-step after a final step, turn-end past a step boundary, turn-end before a chained queued Turn, after an error Turn, idle with a timing, busy without one, one waiting request, Stop, the request's own abort, engine disposal, a failed step compaction, and Stop during it. `command-compact` tests pin the forwarded timing and the teardown abort; `ui-chat` tests pin the Host service over the volatile field, the Settings row, the waiting label, the localized result, and both folds. `apps/web/tests/compact-while-busy.e2e.ts` runs the shipped Web composition over the real wire with paced replay: Interrupt from the Settings row compacts between the Turn's two steps, and Queue compacts after `turn/end`, shows the waiting card and a localized refusal of a second request, and keeps the card visible after the Turn folds.
