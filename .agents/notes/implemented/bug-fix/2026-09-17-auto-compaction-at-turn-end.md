# Agent Note: Automatic compaction moves to the end of the turn

Status: implemented

English | [中文](2026-09-17-auto-compaction-at-turn-end.zh.md)

Related: [a live policy seat for automatic compaction](../feature/2026-09-14-auto-compaction-policy-seat.md) — the seat this uses, unchanged; the shipped desktop composition now answers `false` through it.

## Problem

`BasicCompactionEngine` registers automatic pressure compaction on `agent/pre-step`, and that listener has no memory across steps. Every failure — a summarizer call that fails, a stability revalidation that rejects, a shrink that does not shrink — is caught, written as one `ctx.logger.warn(… continuing the turn)`, and dropped; the next step calls `compactIfNeeded` again against the same conversation, the same threshold, and the same failing summarizer. `warnedPressureConfigTargets` suppresses the repeated *message* for a misconfigured target, not the repeated attempt. A summarizing model that is down therefore costs one full-prefix request per step for as long as the turn runs, and since the rc.33 failure card, one notice in the transcript per step. The client's `compactionDefinition` documents that pile-up as a limitation it cannot collapse: each compaction is its own Context keyed by its `compactionId`, and the engine offers no backoff for a Definition to observe.

The moment is also wrong for a product user independently of failure. The compaction is a full model call over the conversation prefix, so a reply being read stops for as long as that call takes, in the middle of work the user is watching.

## Decision

The desktop composition's `@haoran/dsh-auto-compact` (0.2.0, vendored as a tarball) moves the trigger out of the turn. No harness package changes.

Its `compactionPolicy.isEnabled()` now answers `false` unconditionally. That is the seat's documented meaning — `compaction-basic` gates only the pressure path on it, and overflow recovery is deliberately unaffected because there the provider has already refused the request — so one constant closes the between-steps path with no core patch.

The plugin then triggers its own compaction from an `agent/status` listener, acting only on the running-to-idle transition: it reads `ctx.sessionProjections.snapshot(session, ['contextPressure']).values.contextPressure`, compares `projectedTokens ?? pressureTokens` over `contextWindow` against the share the user set, and calls `ctx.compaction.compactNow(agent, signal)`. The reading is the usage ring's own wire value, the same one `occupancyTokens` takes; a session with no usage sample or no known route capacity has no reading and nothing triggers, exactly as the ring renders nothing there.

`compactNow` is the published idle entry point. It claims the agent's idle phase through `runMaintenance`, so waking input queues behind the compaction instead of racing it, and its `sourceCommandId` parameter is optional. A call that omits it writes the ordinary `compaction/start` / `summary` / `end` bracket with no `sourceCommandId`, which is precisely what `compactionDefinition.match` claims — so a successful run renders the existing checkpoint card and a failed one the existing failure card, with no new session event, no new client node kind, and no card-drawing in the plugin.

One attempt per turn end, one at a time per agent, and the next reading is not taken until the next turn ends. That gap is the backoff the pre-step path does not have: a run that fails, or that leaves the conversation still above the share, waits for new work rather than repeating immediately.

## What the shipped behavior gives up

`compactNow` selects its range with `retainTokens: 0`, so it keeps no verbatim tail — the conversation up to the last balanced boundary becomes one summary, the same reduction `/compact` performs. The pre-step path retained a tail sized by `retainRatio`/`retainTokens` because it was making room for a request about to go out; this one is not, so a user at 60% now gets a fuller reduction, later, instead of a partial one, sooner. Both halves of the plugin's README state it, and so does the desktop-shell built-in table.

`thresholdRatio()` has no reader in the shipped composition while `isEnabled()` answers false, since the pressure path is the only thing that consulted it. The seat keeps both methods: it is one published key, and a backend that wants the ratio can still read it live.

A `/compact` typed during a running turn still fails immediately and is not re-run when the agent settles. `ManualCompactionErrorCode` never leaves the process — `command/done` carries only `kind: 'error'` and the handler's rendered English text, and there is no context event for a settled command — so `busy` cannot be told apart from an early cancellation by anything durable. The structural proxy, no `compaction/start` for that `commandId`, matches a cancellation just as well, and re-running a compaction the user cancelled is worse than not re-running one that was refused.

## Alternatives considered

**Call `compactIfNeeded(agent, 'pressure', signal)` from the idle path.** It would have kept the retained tail and the per-model policy merge. Rejected because it is written for inside a turn: `compactRegion` passes `owner: 'current-turn'`, and `compactSurfaceRegion` throws outright when the session has no open turn. It also takes no maintenance claim, so a waking message could open a turn underneath a running summarization.

**Add backoff inside `compaction-basic`.** Rejected under the fork's standing orders. This is a plugin-layer problem with a plugin-layer answer, and the compaction family is already the patch set with the most active upstream conflict surface; a state-holding change to `compactIfNeeded` would have to be re-ported on every rolling sync.

**Keep the trigger between steps and suppress attempts from the plugin.** Not implementable: `isEnabled()` is on or off for the whole pressure path, and no signal tells the plugin that an attempt failed on a particular agent. Inferring it from `compaction/end` text and flipping a global switch would be guesswork with a user-visible cost.

**A new session event carrying the automatic trigger's outcome.** Rejected for the same reason the failure card rejected it: `Session.append()` offers no way to mark an envelope `ignorable: true`, so a fork-only required event bricks every log a build that does not know the type reads.

## Consequences

The desktop line compacts once, after the reply is finished, on the number the usage ring shows, and a failing summarizer costs one attempt and one card per turn rather than per step. The harness's own overflow recovery is untouched, and so is every harness package: the change is the vendored tarball, its dependency entry, the generated third-party notices, and the built-in table's row. `packages/auto-compact/tests/idle-compaction.spec.ts` in the plugin repository pins the transition rule, the threshold edges, the switch, the single-flight guard, and the one-line-per-failure logging across 19 cases.
