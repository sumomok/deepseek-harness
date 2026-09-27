# Agent Note: A manual `/compact` during a reply answers in the composer

Status: implemented

English | [中文](2026-09-27-manual-compact-busy-notice.zh.md)

## Problem

A user typed `/compact` while a reply was running and reported that nothing happened. The Host runs manual compaction through `compactNow`, which calls `agent.runMaintenance` and throws `busy` unless the agent is idle, so the command settled as a failed `/compact` card. That card was a `manual-compaction` node inside the running Turn, and the `compact` and `standard` work-details modes fold process groups even while a Turn runs, so the card was hidden. The composer shows nothing for an admitted command: `runDetached` raises a composer notice only for an admission failure, and a busy refusal is an admitted command whose handler failed. The [automatic compaction running row](2026-09-18-auto-compaction-running-card.md) had already been taken out of the group; the manual card had not.

## Decision

**Refuse in the composer while the Session reports `running`.** `ui-chat` hangs an `action` decoration on the Host `compact` command through `commandUi.decorate`, the same seam `ui-message-feedback` uses for `/feedback`. Its `available` reads the Session snapshot's `running` flag, so outside a running Turn the decoration does not apply and the bare command reaches the Host unchanged. Inside one, a bare menu pick or Enter consumes the typed token, sends nothing, and raises an `error` composer notice: `正在回答，等这一轮结束后再压缩` in Chinese, `A reply is in progress. Compact after this turn ends.` in English. The `error` level is the composer's transient Toast. The persistent `info` strip was not used because nothing clears it when the Turn ends, so it would keep saying a reply is in progress after the reply finished.

**Refuse rather than queue.** A busy composer queues ordinary messages into the agent inbox through `ISession.prompt` with `queue` or `steer`. Commands never enter that inbox, and the Host has no mechanism that runs a command once the agent is idle; queueing `/compact` would need a Host-side command queue and a new session-log record. The command path's existing busy-time behavior is refusal: `matchEnter` refuses a command that does not accept attachments with one composer notice and executes nothing.

**Take the Host's card out of the process group.** `process-groups.ts` lists `manual-compaction` among the independent roots beside `compaction-running`. A `/compact` that still reaches the Host during a Turn — sent by another client, or sent before this client observed `running` — renders its refusal outside the folded group. An idle `/compact` has no Turn and was never grouped.

**Why this is a core patch.** The decoration uses an existing extension point, but whatever registers it must ship on both the desktop line and the console line, and a package outside this repository reaches only the desktop. The grouping rule has no extension point: the independent-root set is a constant inside `ui-chat`. `ui-chat` already owns the `/compact` card and the `message.compaction.*` copy, so both halves live there.

## Alternatives considered

**Queue `/compact` until the Turn ends.** Rejected for the reason above: it needs a Host command queue and a new durable record for a command that the user can simply repeat.

**Change `command-compact` to wait for idle.** Rejected: the handler would hold a command open for the rest of the Turn with no visible state, and a Stop would have to cancel two operations.

**Localize the Host's busy text instead of refusing in the client.** Rejected as the only change: the card would still be the only feedback, and inside a Turn it was the hidden part.

**Ship the decoration from the fork's desktop plugins.** Rejected: the console line does not load them.

## Consequences

The typed `/compact` is consumed, so the notice is the only trace of the refusal; the user retypes the command after the Turn. The notice appears where the composer's Toasts appear, at the top of the conversation column. A Session that is not `running` while the Host runs maintenance — the fork's end-of-turn automatic compaction — gets no notice: the command reaches the Host and the Host's English `busy` text appears on the card, outside any Turn. Whole-Turn folding of a completed Turn still hides a `manual-compaction` card that landed inside that Turn, as it hides every process row; only the process-group fold is lifted.

**Retirement.** The decoration retires when upstream handles a busy `/compact` itself, in the client or the Host. The grouping entry retires when upstream lists `manual-compaction` as an independent root or otherwise keeps an in-Turn command card out of the folded group. The ledger entry `manual-compact-busy-notice` in `.claude/core-patches.md` carries the mechanical checks.

## Testing

`packages/client/ui-chat/tests/compact-busy.client.spec.ts` pins that the decoration applies only while the Session is `running` and writes the current localized notice to that Session's composer. `chat-apply.client.spec.tsx` pins that `apply` registers it once `commandUi` is composed. `chat-view.client.spec.tsx` renders a failed `manual-compaction` inside an open Turn in the `compact` mode and pins it outside the folded group. `apps/web/tests/compact-busy.e2e.ts` runs the shipped Web composition over the real wire: it parks a Turn, sends `/compact`, and pins the notice, the emptied composer, and the absence of `command/run`; it then sends the same command over `commands/execute` and pins the Host card outside the group. Removing the `running` check, the notice call, the `apply` wiring, or the `INDEPENDENT` entry each fails its test.
