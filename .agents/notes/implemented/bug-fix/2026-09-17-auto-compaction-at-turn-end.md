# Agent Note: Automatic compaction moves to the end of the reply

Status: implemented

English | [中文](2026-09-17-auto-compaction-at-turn-end.zh.md)

Related: [a live policy seat for automatic compaction](../feature/2026-09-14-auto-compaction-policy-seat.md) — the seat's code is unchanged, and this note partially supersedes its account of *when* the shipped desktop composition compacts.

## Problem

`BasicCompactionEngine` registers automatic pressure compaction on `agent/pre-step`, and that listener has no memory across steps. Every failure — a summarizer call that fails, a stability revalidation that rejects, a shrink that does not shrink — is caught, written as one `ctx.logger.warn(… continuing the turn)`, and dropped; the next step calls `compactIfNeeded` again against the same conversation, the same threshold, and the same failing summarizer. `warnedPressureConfigTargets` suppresses the repeated *message* for a misconfigured target, not the repeated attempt. A summarizing model that is down therefore costs one full-prefix request per step for as long as the turn runs, and since the rc.33 failure card, one notice in the transcript per step. The client's `compactionDefinition` documents that pile-up as a limitation it cannot collapse: each compaction is its own Context keyed by its `compactionId`, and the engine offers no backoff for a Definition to observe.

The moment is also wrong for a product user independently of failure. The compaction is a full model call over the conversation prefix, so a reply being read stops for as long as that call takes, in the middle of work the user is watching.

## Decision

The desktop composition's `@haoran/dsh-auto-compact` (0.2.2, vendored as a tarball) moves the trigger out of the turn. No harness package changes.

Its `compactionPolicy.isEnabled()` answers `false`, which is the seat's documented meaning — `compaction-basic` gates only the pressure path on it, and overflow recovery is deliberately unaffected because there the provider has already refused the request. The plugin then triggers from an `agent/status` listener on the running-to-idle transition, reading `contextPressure` and calling `ctx.compaction.compactNow(agent, signal)`.

`compactNow` is the published idle entry point. It claims the agent's idle phase through `runMaintenance`, so waking input queues behind the compaction instead of racing it, and its `sourceCommandId` parameter is optional. A call that omits it writes the ordinary `compaction/start` / `summary` / `end` bracket with `turn: null` and no `sourceCommandId`, which is precisely what `compactionDefinition.match` claims — so a successful run renders the existing checkpoint card and a failed one the existing failure card, with no new session event, no new client node kind, and no card-drawing in the plugin. The checkpoint side of that combination was already covered in `conversation-node-definitions.client.spec.ts`; this change adds the failure side, because a `turn: null` bracket that closes on an error is an event shape no shipped build has produced before.

One attempt per driver exit, one at a time per agent, and the next reading is not taken until the next exit. That gap is the backoff the pre-step path does not have. It is per driver exit rather than per turn: `kick` loops `while (await this.turn())`, so several queued messages drain as consecutive turns inside one running stretch and share one compaction at its end.

## Which plane the engine is on

The trigger cannot be installed by injection, and getting that wrong is worse than doing nothing.

`packages/bundle/web-app/cordis.patch.yml` disables `compaction-basic`, `command-compact`, and `tool-result-pruner` on the host plane; each preset mounts them inside a group carrying `isolate: { compaction: true, toolResultPruner: true }`. A realm is invisible outside the group that declares it — including to the host plane a bundle patch's bare `- insert:` row lands on — and `agent-presets` states the consequence in its own prose twice: "a host row that `inject`s a service cannot use this, because injection resolves before any session exists and has no agent to key by; such a service belongs on the host plane instead."

So the engine is resolved per agent:

```ts
declare const ctx: import('@deepseek-ai/cordis').Context
declare const agent: import('@deepseek-ai/dsh-agent').Agent
const engine = ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? ctx.get('compaction')
```

and the seat is coupled to that lookup. `isEnabled()` answers `false` only once it has succeeded for some agent, and `true` — upstream behaviour, unchanged — while it has not. That is what keeps a fresh process from closing the harness's path before the plugin can replace it: a host-plane `inject(['compaction'])` never fires in this profile, while the host-provided policy DOES reach the engine inside the realm, so an uncoupled constant `false` would have left the desktop with no automatic compaction at all and an inert switch and slider.

The coupling is per process, not per conversation. The seat takes no agent, so one answer governs every agent the engine serves; reaching an engine for one conversation closes the harness's path for all of them. A conversation whose own composition answers neither lookup is reported in the host log once and compacted by nobody — and has no engine in it to have compacted it either way.

Nothing is cached. An agent can be re-linked to a different preset while its conversation is still empty — `agentPresets.recompose`, which the desktop reaches through the preset picker — and a cached engine would keep summarizing through the realm the conversation left, including for a preset that mounts no compaction. `serviceForAgent` walks the service store's own symbols, so the lookup runs once per driver exit instead. The `agent/created` probe is wrapped and calls `serviceFor` only when the mounted roster has that method: `AgentRegistry.announce` does not contain a creation listener's synchronous failure, so a throw there would veto the session's publication rather than degrade.

The token meter is deliberately not in those realms — the presets say so, because it owns process-wide projection units — so `ctx.get('tokenMeter')` reaches it from the host plane and needs no addressing.

## Which endings are skipped

**A reply the user stopped, and a conversation being disposed.** Both close their turn with `turn/end` carrying `reason.kind === 'aborted'` and both then publish an idle status. Compacting there answers Stop with an unrequested full-conversation summary the composer offers no way to interrupt — `ReactLoopAgent.status` reports the maintenance phase as `idle`, so the session controller broadcasts `running: false` and the composer's Stop control is already gone. Disposal is worse: `agent-loop` disposes by `cancel({kind:'disposed'})` followed by `await whenIdle()`, and a compaction started from that idle transition is a summarization the disposal then waits on, begun after the only cancellation that would have stopped it.

No context event reports a cancellation and no projection publishes the end reason, so the signal is the closing event itself, observed through `ctx.on('session/event')` as it commits rather than by scanning the log back. The first attempt also aborted each run from an `agent/disposed` listener; that listener is gone, because disposal is `cancel` → `whenIdle` → scope disposal → detach and `cancel()` aborts the maintenance phase too, which `compactNow` already folds into its operation signal — so `agent/disposed` always arrived after every run it could have stopped.

Delegated agents are **not** skipped. They were in the first attempt, with `ctx.agents.roots().includes(agent)`, and that was wrong: a subagent composes from its parent's standing mount through `agentPresets.composeFrom`, so the realm's `compaction-basic` reads the same host-plane policy and its between-steps path is closed by the same `false`. Skipping the idle path for it left it with overflow recovery and a default budget of one retry. Giving the seat a per-agent answer is not available — `isEnabled(): boolean` takes no agent, and changing that signature is a core patch — so every agent that resolves an engine is compacted at its own driver exit. The accepted cost is one summarization per delegated driver exit above the share, on a session often discarded soon after.

## What the shipped behavior gives up

**A shorter retained tail.** `compactNow` selects its range with `retainTokens: 0`: `selectCompactableRange`'s accumulation loop breaks on its first iteration, so the last surface node — normally the reply that just finished — is retained verbatim and everything before it, back to a balanced tool boundary, becomes one summary. The pre-step path retained a tail sized by `retainRatio`/`retainTokens` because it was making room for a request about to go out; this one is not. A user at 60% gets a deeper reduction, later, instead of a shallower one, sooner. The Settings card's own hint now says so, not only the READMEs and the built-in table, because the slider goes down to 20%.

**Any sign of it on screen.** The maintenance phase reports itself as `idle`, so the session controller broadcasts `running: false`, the composer's Stop control is gone, and a message sent during the summary is latched behind it and does not enter the transcript until the turn actually opens. `compactionDefinition.buildViewNode` draws nothing from a lone `compaction/start`, so the conversation shows nothing either. A full-prefix summary can take tens of seconds. A browser-half progress row is feasible and deliberately not built here: the seat exists (`conversation.composer.dock`, a session-scoped list slot below the composer that shadows no shipped UI), but no registered projection publishes "a compaction bracket is open", so the plugin would need its own conversation-node definition folding `compaction/start`→`end`, a plugin-owned client store, locale keys and client tests. Deferred on that cost; the release notes say what a user sees instead.

**All in-turn protection.** The pre-step path was buying something this note's problem statement does not mention: a single long tool-heavy reply that outgrows the window on its own. Closing it leaves overflow recovery as the only floor for that case, and its default budget is one retry (`maxOverflowRetries ?? 1` in `compaction-basic`'s config; no shipped preset overrides it). Accepted deliberately — compacting mid-reply is the behaviour being removed — and named in both READMEs so a deployment expecting very long tool-heavy replies knows which knob to raise.

**`thresholdRatio()` has no reader** in the shipped composition while `isEnabled()` answers false, since the pressure path is the only thing that consulted it. The seat keeps both methods: it is one published key, and a backend that wants the ratio can still read it live.

## Deferred on cost: the busy `/compact` queue

A `/compact` typed during a running turn fails immediately — `compactNow` calls `runMaintenance`, which throws synchronously on a non-idle agent — and is not re-run when the agent settles.

It is implementable. What is not implementable is inferring the outcome of the *built-in* command from the log: `command/done` carries only `kind: 'error'` and the handler's rendered English text, the commands service dispatches no context event for a settled command, and the structural proxy — no `compaction/start` for that `commandId` — matches an early cancellation just as well.

Owning the gesture removes the ambiguity entirely. `ManualCompactionError.code` is an ordinary public export of `@deepseek-ai/dsh-compaction`, so a plugin that makes the call itself reads `busy` directly; and the commands registry documents agent-scoped shadowing — a command registered beneath an agent's own context shadows the global definition of the same name for that agent — with first-party precedent for reaching `agent.ctx` from a plain plugin in the `schedule` plugin. The deferral is a cost judgement, not an impossibility: it takes the desktop line's `/compact` over, so upstream changes to that command stop arriving silently; it must reproduce `expectedFailure()`'s copy for the other five codes; and the queued run needs a rule for the user changing their mind.

## Alternatives considered

**Call `compactIfNeeded(agent, 'pressure', signal)` from the idle path.** It would have kept the retained tail and the per-model policy merge. Rejected because it is written for inside a turn: `compactRegion` passes `owner: 'current-turn'`, and `compactSurfaceRegion` throws outright when the session has no open turn. It also takes no maintenance claim, so a waking message could open a turn underneath a running summarization.

**Install the trigger with `ctx.inject(['compaction'], …)`.** The obvious shape, and the one the first attempt shipped. Rejected on evidence: a probe against the real vendored Cordis shows a host-plane injection never activating behind an `isolate` realm while the same provider without a realm does, and the policy still crossing into the realm — so that shape closes the harness's path and installs nothing.

**A constant `false` seat.** Rejected with it: a constant that does not depend on having found an engine is exactly what turns an unreachable engine into a conversation that never compacts.

**Add backoff inside `compaction-basic`.** Rejected under the fork's standing orders. This is a plugin-layer problem with a plugin-layer answer, and the compaction family is already the patch set with the most active upstream conflict surface; a state-holding change to `compactIfNeeded` would have to be re-ported on every rolling sync.

**A new session event carrying the automatic trigger's outcome.** Rejected for the same reason the failure card rejected it: `Session.append()` offers no way to mark an envelope `ignorable: true`, so a fork-only required event bricks every log a build that does not know the type reads.

## Consequences

The desktop line compacts once, after a reply the user let finish, on the number the usage ring shows — falling back to the token meter's own total for a conversation no provider has billed, which is what keeps image-heavy sessions compacting at all. A failing summarizer costs one attempt and one card per driver exit rather than per step. The harness's own overflow recovery is untouched, and so is every harness package: the change here is the vendored tarball, its dependency entry, the generated third-party notices, the built-in table's row, one added client case for the `turn: null` failure bracket, and this note. `packages/auto-compact/tests/{idle-compaction,realm}.spec.ts` in the plugin repository pin the transition rules, the fresh per-exit lookup, a roster without `serviceFor` and one that throws, the threshold edges, the switch, the single-flight guard, the per-failure logging, and — against a real Cordis runtime — the realm visibility this decision turns on.
