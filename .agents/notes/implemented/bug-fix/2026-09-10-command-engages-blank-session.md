# Agent Note: A standalone command engages the session it ran in

Status: implemented

English | [中文](2026-09-10-command-engages-blank-session.zh.md)

## Problem

Sending `/btw <question>` as the very first message of a brand-new session left the window looking like nothing had happened. The host ran the command and logged it — `command/run` at seq 3, `command/done` at seq 4 in the acceptance session's log — but the centre column kept the welcome hero, rendered no command card, and the sidebar never listed the session at all. The only way to see that the command had run was to send an ordinary message afterwards.

Every surface was reading the same bit. `applySessionListMetadata` in [`packages/api/session-controller/src/list.ts`](../../../../packages/api/session-controller/src/list.ts) folded `blank` down on `turn/start` and on nothing else, so the host summary of a command-only session still said `blank: true`. On the client, `Session.prompt()` was the only path that lowered the local mirror, and `CommandUiRuntime.execute` in [`packages/client/ui-commands/src/client/service.ts`](../../../../packages/client/ui-commands/src/client/service.ts) called `ctx.remote.commands.execute` without ever touching the `Session` object the line was addressed to.

From that one bit the rest followed: `conversationPhase` stayed `'blank'`, so `ConversationRoot` kept the hero and `ConversationSession` returned `null` for the view; `sessionVisible` in [`packages/client/ui-workspace/src/client/tree.ts`](../../../../packages/client/ui-workspace/src/client/tree.ts) shows a blank session only while it is the current one, so no row survived a switch away; and `connectWorkspace`'s reuse scan still treated the session as the workspace's provisional New Session, so the next `+` would hand the same session back.

## Decision

`blank` means the session has nothing to show and nothing to address, and a durably logged command run is something to show. The bit falls on the first `turn/start` **or** the first `command/run`, and both halves of the system agree on that.

**The host fold.** `applySessionListMetadata` clears `blank` on `command/run` as well as `turn/start`. `command/run` rather than `command/done` is the flip point because the executor appends it before the handler runs: admission is the durable fact, the transcript renders that event as the command node's first half, and a handler that fails or never returns has still produced a card. The remaining standalone events a fresh session can accumulate — `plan/mode`, `session/title`, `permission/preset`, `sandbox/mode` — still leave the bit up: they record a setting, not content, and none of them renders a node of its own. The unit's `stateVersion` goes from 1 to 2, because a checkpoint row written under the old fold holds the older verdict for the same log; version 2 discards those rows and refolds, which is what keeps a reopened command-only session out of the hero.

**The client mirror.** The blank→false flip moves out of `prompt()` into `Session.markEngaged()`, published on the outward `ISession` face. Its contract is the one `prompt()` already relied on: the mirror only ever lowers, so a caller must already hold the host's acceptance. `prompt()` calls it on the accepted branch exactly as before; `CommandUiRuntime.execute` calls it through `ctx.sessions.binding(sessionId)?.session` once the execute RPC returns a matched result. A handler-error result engages too, matching the host, while an unmatched line — which never reached a handler and logged nothing — leaves the session blank, hidden, and reusable. A session with no local binding is skipped: the host summary carries the same verdict on the next list pull.

`markEngaged()` sets no send marker and opens no first-turn debt, so a command-only session reports `blank: false, promptAttempted: false, awaitingFirstTurn: false` and `conversationPhase` resolves it as `'active'` on the first frame after the RPC settles.

## Testing

[`session-list-blank.host.spec.ts`](../../../../packages/api/session-controller/tests/session-list-blank.host.spec.ts) drives the projection through a real `Session`: the configuration-event family keeps the summary blank, a command lifecycle clears it, and the first turn clears it; two direct folds pin that `command/run` is the flip point and `command/done` is not, and that an already-cleared bit stays down. [`session.client.spec.ts`](../../../../packages/api/session-controller/tests/session.client.spec.ts) pins `markEngaged()` itself — the lowered bit without a send marker or a pending first turn, and the single `onEngaged` call across two invocations. [`service.client.spec.ts`](../../../../packages/client/ui-commands/tests/service.client.spec.ts) pins the caller: an admitted line engages the addressed session, a handler error engages it too, an unmatched line and a failed call do not, and an unbound session is skipped. [`skeleton.client.spec.tsx`](../../../../packages/client/ui-conversation/tests/skeleton.client.spec.tsx) pins the phase and the rendered shell — a session whose only content is an executed command is `'active'` and shows no hero.

No recorded-session snapshot records the projection version or a summary blank bit; `pnpm run test:snapshot` is unchanged by this fix.

## Alternatives considered

**Flip the client mirror only, and leave the host fold alone.** It is the smaller change and it fixes the sending tab. It fixes only the sending tab: the sidebar row, every other tab, and the same session reopened tomorrow all read `SessionSummary.blank`, which is computed on the host. A `/btw`-only session would leave the hero until the page reloaded and then return to it.

**Clear `blank` on `command/done` instead.** It flips on a finished command rather than a started one, which reads as the more conservative choice. It is the wrong event for what the bit means: the transcript already shows the run, and a command that fails, is cancelled, or leaves its `command/done` behind would keep the hero over a card that is on screen.

**Give the summary a second column beside `blank` — "has something to show" — and leave `blank` turn-based.** It would keep `connectWorkspace` reuse and list visibility exactly as they are while letting the conversation shell leave the hero. All three consumers want the same answer for a command-only session: it should be listed, it should open on its transcript, and it should not be handed back as New Session. A second column would make each of them choose which bit to read, and the two would have to be kept in agreement forever.

**Keep `stateVersion` at 1.** Nothing in the state's shape changed, so the schema still validates. The fold changed, which is exactly what the version guards: a session checkpointed under version 1 would be served its old `blank: true` from the cache row and reopen on the hero.

**Reuse `promptAttempted` as the engagement latch.** It already survives a stale `blank: true` from a list pull, so setting it in `markEngaged()` would harden the flip for free. It means "a send was attempted" and drives the composer's `engaging` phase; a command attempts no send. The manager's `engaged` list mutation already replays over an in-flight `session.list` baseline, which is the case that latch would have covered.

**Name the commands that count — an allow-list in the fold.** `/btw` produces a visible answer; `/plan` and `/permission` flip a setting the header already shows. A list of command names inside a projection is a deployment-varying tunable in the one place that must stay a pure fold, and it would disagree with the transcript, which renders a node for every one of them.

## Consequences

A session whose only content is a command is now an ordinary session: it holds a sidebar row, opens on its transcript, and is no longer the provisional New Session a Workspace connect reuses. That applies to every host command, `/plan` and `/permission` included — flipping plan mode before the first message now surfaces the session and costs the next `+` a fresh one. This is the transcript's own verdict: those runs already render a command node.

`command-feedback` loses its documented limitation. `/feedback` on a fresh session now renders its acknowledgement row, because the session leaves the hero on the same admission that logged the command.

Preset switching is unaffected on the host: `agentPresets.select` gates on the `turnBoundary` projection, which no command touches, so a command-only session can still be recomposed. The client's staged-preset applier does drop its stage on a session it sees as non-blank, but the interactive chip occupies the `conversation.hero.agentPreset` slot, which is gone once the hero is, so a person cannot reach that path on a session that just ran a command.

Every cached `sessionListMetadata` row is discarded once, on the first list read after the upgrade. The affected sessions refold from their logs and the next checkpoint rewrites the rows at version 2.
