# Agent Note: A live policy seat for automatic compaction, on the meter's own number

Status: implemented

English | [中文](2026-09-14-auto-compaction-policy-seat.zh.md)

## Problem

Two defects sit on top of each other in the automatic pressure path.

The trigger and the meter disagree about what "how full is the context" means. The ring beside the composer divides `contextPressure.projectedTokens ?? pressureTokens` by the routed window — a prompt-side figure: uncached input plus cache reads and writes, with the response's output excluded because the next request will not resend it. `BasicCompactionEngine.compactIfNeeded` compared `TokenMeasurement.totalTokens`, whose provider baseline is `inputTokens + cacheRead + cacheWrite + outputTokens`. The two therefore differ by exactly the last call's output tokens, and a user who sets a percentage is setting it against a number nobody shows them.

And the threshold is load-time only. `thresholdRatio` is a plugin config field validated in `resolveConfig` and frozen there; `auto` decides at construction whether the listeners register at all. A desktop settings page that lets a user say "start condensing at 60%", or turn automatic condensation off for one session, has nothing to write to — changing either means editing the composition and reloading the plugin tree. The engine also mounts once per agent preset, so no settings namespace can live inside it.

## Decision

An optional host-plane Service Definition the engine reads fresh on every step, plus a numerator taken from the projection the meter already publishes.

```ts
/** Live automatic-compaction policy a host-plane plugin provides from user settings. */
export interface CompactionPolicy {
  /** Whether pressure-triggered compaction runs at all; overflow recovery is unaffected. */
  isEnabled(): boolean
  /** Share of the model's context window (0–1) at which the next step compacts first. */
  thresholdRatio(): number
}
```

The key is `compactionPolicy`, declared on cordis `Context` by compaction-basic and read through `ctx.get('compactionPolicy')` — the optional-sibling pattern the engine already uses for `toolResultPruner`. Nothing is cached: the read happens inside the `agent/pre-step` listener and inside `compactIfNeeded`, so a user moving a slider takes effect on the next step. The preset realms isolate `compaction` and `toolResultPruner` and nothing else, so one host-plane provider serves every preset's engine instance, and the settings namespace stays where a single owner can hold it.

**Absent service means upstream behavior**, exactly. `isEnabled()` returning `false` suspends the pressure path only — overflow recovery still runs, because there the provider has already refused the request and a user who turned automatic condensation off did not ask to lose the last defense. `thresholdRatio()` replaces the configured ratio *after* `resolveTargetPolicy` has merged the exact-target override, which means a `modelPolicies` entry's `thresholdRatio` is ignored while the rest of that entry — retention above all — still applies. One live user setting outranking a per-model tuning table is the point of the seat; retention is deliberately not exposed, because it is a capacity-scaled budget with a validity relation to the threshold, not a number a user has an opinion about.

A returned ratio outside `(0, 1]`, or one whose `floor(contextWindow × ratio)` would not clear the retained tail, is refused: the engine warns once per `provider/model` and keeps the configured ratio. The comparison is the same one `resolveCompactSpec` performs, run against the already-scaled configured spec, so the fallback path cannot itself throw and a bad capacity still surfaces as the existing `TargetPressureConfigError` rather than as a policy warning.

`config.auto: false` stays a hard off. It is a composition statement, not a user preference, and it keeps deciding at construction whether any listener registers; the live switch is the run-time layer above it.

**The numerator is the meter's, wherever the two describe the same request.** `compactIfNeeded` now reads `ctx.sessionProjections.snapshot(session, ['contextPressure']).values.contextPressure` and selects `projectedTokens ?? pressureTokens` — the same wire value, produced by the same projection unit and the same `view` function, that `contextOccupancy` divides in the browser. Not a re-derivation: the identical object. Every comparison against `spec.thresholdTokens` uses it, including the convergence loop's exit test, so entry and exit criteria stay one quantity. `TokenMeasurement` still prices retention and range selection; only the trigger moved. `sessionProjections` joins the engine's `static inject`, which states a dependency the package already had transitively — `tokenMeter` cannot load without the registry — and keeps the read free of a fallback no valid composition can reach.

The read is gated on `measurement.baseline.kind === 'usage'`, and that gate is load-bearing rather than defensive. The projection is provider-anchored: it publishes the last usage sample plus the surface's movement since, and it prices that movement with the route-INDEPENDENT heuristic. It therefore cannot see a routed adapter's declared image pricing for history the provider has not billed yet, and its own type documents the consequence — the pair is "a user-facing reference, not a billing or gating input". A measurement whose baseline is not `usage` is exactly that state: no provider figure is anchoring it, `totalTokens` is then a route-priced estimate carrying no output tokens at all, and it is the only reading that sees the pressure. The repository already had the proof: `snapshots/acp/image-compaction` exists to show route-priced visual tokens driving a pressure compaction, and an ungated projection read makes that scenario stop compacting entirely — six images, a usage sample of three input tokens, and a numerator that never approaches the threshold. So the seam is: the ring's number whenever the ring is anchored, the meter's own number when it is not. Stated for a reader who does not know either term: a text conversation triggers at the percentage the ring shows; a conversation the provider has not yet billed, or one whose images the provider has not yet priced, triggers on the engine's own reading.

**Failure visibility needs no new core vocabulary.** Every failure that opens the region bracket — summarizer call, stability revalidation, shrink rejection, commit — already closes it with `compaction/end` carrying `errorChain(error)`. That event is durable, already crosses the wire, and is already claimed by the client's `compactionDefinition.match`; only `buildViewNode` returned `null` because no replacement checkpoint landed. The fix is therefore entirely in the conversation view, and it is the second half of this overlay.

## The failure card

`compactionDefinition` gains a third piece of evidence beside the summary and the checkpoint: a `compaction/end` whose `error` is present. `buildViewNode` still prefers a landed checkpoint — a bracket that commits its replacement closes cleanly, so the two cannot describe the same transaction — and otherwise emits a `compaction-failure` Chat node anchored at the errored end's own seq, carrying that seq, its time, and the reason text. An `error` that is absent, or present but blank, is not a failure and not a reason respectively: the first produces no node, the second produces a node whose `reason` is null and whose card falls back to locale copy.

The renderer is the max-tokens notice's shape — a `role="status"` row with a warning dot, a locale title, and one line of detail — because that is what this is: a persistent, positioned notice that something the user did not ask for did not happen. The reason is the backend's own text, so it is data, not copy; it stays on one line with `text-overflow: ellipsis` and carries the full string in `title`, which keeps a long convergence-failure chain reachable without letting it reflow the transcript.

Manual `/compact` failures do not reach this card, and should not. `command-compact` calls the same bracket, so a manual failure inside it writes the same errored `compaction/end` — but every manual lifecycle event carries `sourceCommandId`, which `compactionDefinition.match` has always excluded, routing it to `commandDefinition` and the command card that already renders `command/done`'s own failure text. Two cards for one failure would be worse than one. The pre-bracket manual failures (`busy`: no idle agent, or a live compaction) write no event at all and reach the user the same way, through the command result.

There is no trigger field on the card. The session log does not record whether an automatic compaction ran for step pressure or for overflow recovery — `compaction/start` carries only `compactionId`, the optional command id, and the owning turn — so a trigger label would have to be invented. The card says which transaction failed and why; the definition only claims automatic compactions, so "automatic" is the whole of what the trigger would have added.

## Alternatives considered

**Derive the numerator from `TokenMeasurement` by subtracting the anchor's output tokens.** Rejected: it reconstructs the projection's arithmetic in a second place. The two would agree only as long as nobody changes either fold, and the claim "the trigger fires at the percentage on screen" would rest on that coincidence instead of on shared code.

**Read the projection unconditionally.** Rejected on evidence: `snapshots/acp/image-compaction` goes from compacting to not compacting, because the projection prices unbilled image history heuristically. A vision session would quietly lose automatic compaction — the case it exists for.

**A new `compaction/auto-failure` session event.** Rejected on two counts. It is unnecessary — the dominant failure, a summarizer call that fails, already writes `compaction/end` with `error`. And it is not implementable as specified: `Session.append()` offers no way to set the envelope's `ignorable: true` marker, and no production code in the repository sets it. A fork-only required event would make every build that does not know the type refuse the log, which is exactly the session-bricking the fork's standing orders forbid. Marking it ignorable would mean patching the durable append API in `packages/core/session`, regenerating `known-event-types`, and re-recording both SDKs' expected output — a far larger core patch for a case already covered.

**`ctx.emit('compaction/auto-failed', …)` forwarded to an existing client channel.** Rejected because no such channel exists. The forwarder in `packages/api/remotes` has a closed 20-entry allowlist a plugin cannot extend at run time, and its one free-text member, `api-session/error`, lands in `lastAgentError` with no renderer anywhere in `packages/client`. Every `Toast` in the repository is client-local React state with no host address, and `packages/interaction` exposes only blocking `ask`/`request` methods.

**A `form: 'notice'` context injection on failure.** Rejected: it is an append-surface `user/message`, so it costs context tokens and the model reads it — at the exact moment compaction has just failed to free any.

**`thresholdRatio` as a plugin config field the settings plugin rewrites.** Rejected: config is load-time and frozen by `deepFreeze` in `resolveConfig`, so a change means editing the composition and reloading the tree, and the engine's per-preset instances would each hold their own copy.

**Exposing retention through the same seat.** Rejected by scope: `retainRatio` must stay below the effective threshold, so a second user-facing number introduces a pair that can be set into an invalid state. The one exposed number is validated against the configured tail instead.

## Consequences

A host-plane plugin makes automatic compaction a user setting — a percentage and a switch — without forking the engine, without touching the composition, and without a second definition of "how full is the context". The shipped composition mounts no provider, so `dsh` behaves exactly as upstream does: `thresholdRatio: 0.8`, `auto: true`, listeners registered at load.

The trigger moved for every existing deployment whose provider usage anchors the meter, by the size of the last response's output tokens: such a conversation now compacts slightly later than before — at the percentage the ring shows rather than a few points above it. This is the intended correction, and it is the change to watch for in any deployment that had tuned `thresholdRatio` against the old number. Sessions the provider has not anchored, image-heavy ones above all, keep the previous trigger exactly.

**Retirement.** Two overlays retire separately. The failure card retires when upstream renders an automatic compaction failure anywhere in the conversation, in any form. The policy seat and numerator are a fork overlay on an upstream package. If upstream gives automatic compaction a run-time policy input in any form — a service, a settings-backed config reload, a threshold callback — the overlay is retired and the fork's plugin adapts to upstream's form. The numerator alignment retires the same way if upstream moves its own trigger onto the context-pressure projection. Until then both are re-ported on every rolling sync; `packages/compaction` took no upstream changes through 0.1.5-rc.2, so the port surface has been stable.

Package tests carry the evidence. In ui-chat: an errored automatic `compaction/end` produces the failure node with its reason, a landed checkpoint still produces the success marker and no failure node, a clean end produces neither, a blank error reports an absent reason, a window that never loaded the bracket start still builds the node, a manual failure produces no node, and the card renders its title from the locale in both languages with a long reason kept on one line under its `title`. In compaction-basic: the two numerators differ by exactly the reported output tokens on an anchored fixture; a usage sample too small to anchor keeps the route-priced total, and compaction still fires there; a threshold budget placed strictly between them does not trigger, proving the smaller displayed figure is the one compared; a mounted policy compacts at its own ratio and outranks a `modelPolicies` threshold of `1` while that entry's retention still decides the shadowed span; a disabled policy skips pressure yet still recovers from a provider-confirmed overflow; three unusable ratios each warn once per routed target and leave the configured ratio governing; and an automatic summarizer failure leaves a `compaction/end` carrying the error text for the conversation to render.

No snapshot variant accompanies this change. A pressure-path variant would need both a keyed recording and a mounted `compactionPolicy` provider, and no such provider exists in the repository yet — it is the plugin half of this work. The two existing keyless replays are the regression evidence instead, and `snapshots/acp/image-compaction` is the one that decided the baseline gate above: it replays byte-identically, which is the assertion that unbilled image pressure still triggers.
