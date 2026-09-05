# Agent Note: who decides an allowed set of page steps

Status: implemented

English | [中文](2026-09-06-content-act-judged.zh.md)

## Problem

The service-line console runs `@haoran/dsh-llm-permission-gateway` in front of every tool call and, on the deployment [the classification note](../architecture/2026-09-06-content-tools-review-gate-classification.md) describes, leaves `content_act` to be reviewed. Two facts of the waterfall made that review not reach the user.

**A reviewer's allowance did not stop this package's own card.** The gate's allow branch returns `next()` (`src/index.ts:541`), and `next()` is the rest of the chain's decision — cordis's waterfall returns the outermost listener's return value and `next()` shifts one listener at a time (`vendor/cordis/src/events.ts:234-243`). The gate registers with `prepend: true` (`src/index.ts:509`), so it is at the head whatever the mount order; this package's listener registers bare and sits at the tail, and it returned `{kind: 'ask'}` on every allowed call. So a set of steps a reviewer had already judged safe still put a card in front of a person. Two gates, one call — the mechanism's doing, not a misconfiguration.

**A reviewer's `ask` never reached this listener at all.** The gate's ask branch returns without calling `next()` (`src/index.ts:542`), so `approvals.ask(exec.callId)` never ran. The user approving that card then reached a body whose `approvals.confirmed(exec.callId)` was `false`, and the call was refused with `DIALOGS_UNAPPROVED_REFUSAL`. **That half is the gate's to fix, and is being built there for 0.3.0** — the shipped 0.2.0 build still returns from the ask branch without delegating — by delegating in that branch as well. It is recorded here because it is the other reason this package's listener and a reviewer disagreed, and because the carve-out below is what makes this side of it safe either way.

## Decision

**`pageAccess.actApproval: 'always' | 'judged'`, defaulting to `always`.** `always` is what this row has always done, byte for byte: every allowed call becomes a request naming each step in the user's own words. `judged` returns whatever the rest of the waterfall decided — a downstream `deny` is still returned as this package's own, and every other decision passes through untouched.

**Ratified by the owner on 2026-09-06, not decided here.** That a reviewer judges `content_act`, that only a dangerous page action puts a card in front of a person, that the setting takes two values and not three, and that a `judged` row with no reviewer fails closed are the owner's rulings. What this note owns is the shape they were built in.

**`dialogs: "accept"` is asked here in either setting.** Not because it is more dangerous, but because the request composed here is the mechanism: `DialogApprovals.ask()` and `.confirmed()` pair the request the user read with the body that answers the page's own confirmation, and `src/access/dialog-approvals.ts` states that pairing as the module's contract. A `judged` row that handed that clause over would leave the body with no record, so the page's dialog would be cancelled — and a row that let an upstream listener rewrite this `ask` into an allowance would leave a record no one had read the sentence behind. One instance, written out rather than abstracted into a table of step shapes.

**`judged` requires `judgedBy`, and the lookup runs per call.** `judged` is an assertion about the composition, and the only thing this package can check is a name: `judgedBy` is the reviewer's cordis plugin name — for the shipped gate, `llm-permission-gateway`, the value its module exports as `name`. The listener reads `ctx.registry.values()` on every call and refuses the steps while no runtime carries that name. A name that is empty, or absent because the row wrote a bare `judgedBy:` key, is refused at load instead: the empty string is the runtime name cordis records for every inline `ctx.inject` callback, so a guard handed one would find a reviewer in any composition at all. Per call rather than at load because nothing fixes the order the two rows mount in: a load-time check would refuse a composition whose reviewer arrives a moment later, and would keep passing a composition whose reviewer was unmounted. A runtime record is dropped as its last fiber disposes (`vendor/cordis/src/fiber.ts`), so a record found there has a live fiber behind it. The refusal is returned without delegating: a reviewer that judges this call is ahead of this listener, not behind it. That skips more than the decisions behind it — a listener that also records, a hook bridge among them, sees nothing for that call — which is the price of not letting a listener behind this one put a request in front of a person for a call that must be refused. The `Config` JSDoc says outright that this checks the name and not that the named plugin reviews anything.

**The composition is written by the deployment, in the overlay it already owns.** `overlay/content-column.patch.yml` stays at the default, because a deployment may compose the column with no reviewer at all. `overlay/permission-gateway.patch.yml` gains the instruction in its header comment rather than a second row: a patch replaces the targeted row's complete `config` (`vendor/include/src/index.ts:121-124`), so a row targeting this package would have to restate `root`, `pages` and everything else that deployment configured, in a file that knows none of it.

## Alternatives considered

Each of these was measured in the research that preceded the ruling; one sentence and the reason it lost.

**Mark the execution from the gate, through a shared `WeakMap` or a global `Symbol`.** `ToolExecution` has no free field and the two packages are in different repositories, so the only route is an untyped global protocol — refused by "Explicit > implicit at package boundaries" before cost enters.

**Read the gate's settings namespace from this package.** Mechanically possible, and it hard-codes a private third-party plugin's name and settings schema into a package meant to merge back to `develop`; it also answers the wrong question, since `mode: auto` says a reviewer is running, not that this call was judged.

**Give the gate a `judgedTools` list that suppresses the downstream card.** Puts the decision about whose card may be eaten in the hands of the package that does not own the card, and needs the rewrite below to work at all.

**Let the gate rewrite a downstream `ask` into an allowance.** Structurally refused: it breaks the dialog record above, it reverses the gate's own written promise that allowing delegates and never removes another plugin's denial, and it makes "who may ask a person" a function of registration order.

## Decision gate

**0. Which settled principle already says no?** None, and two say yes. "No hardcoded tunables in plugins" asks for exactly this shape — a deployment-varying choice as a validated `Config` field. "Explicit > implicit at package boundaries" is met by resolving the two fields into one value at load rather than reading `?? default` in the listener. "Misconfiguration fails loud" was the one this grazed, and the guard is what closes it: the half-answered row fails at load, and the unmet assertion fails on the call rather than silently running the steps.

**1. How many new surfaces? Two,** both `Config` fields on one existing block. New tools 0, tool parameters 0, routes 0, session events 0, projections 0, dependencies 0, system-prompt lines 0, approval gates 0 — the change removes a card on one path rather than adding one. `SESSION_FORMAT_VERSION` and the `contentAccess` `stateVersion` are untouched, and the settings document the browser half reads is unchanged, because this is a host-side decision the seat never sees.

**2. The smallest version that shows the judgement is better.** The two values, with `judged` meaning "delegate except the dialog clause". One overlay line on a console proves it: browsing the page — clicking a tab, filling a search box — goes from a card every call to none, while a delete or a submit the reviewer stops still reaches a person.

**3. Seam or hard-wired? A seam, narrowly.** The switch is cut; the dialog clause is hard-wired. Three things really about to differ: the console line wants `judged` now, the desktop line composes the same gate with a different column and will not want the same answer, and automation lanes need a third answer that neither value gives. The dialog clause has one instance and stays one.

**4. Boundaries.**

| Direction | The line | The failure it prevents | Term |
|---|---|---|---|
| Neighbour | This package owns one bit — asked or delegated — and the deployment owns the rest. It reads no reviewer's settings, imports no reviewer's types, and knows a reviewer only as a name a row wrote | a package meant to merge back to `develop` depending on a private, tarball-only third-party plugin | permanent |
| Contract | `presentCall` renders the whole step list in every setting; `dialogs: "accept"` is true only for a call whose request the user read; the default is `always`, so a row that says nothing keeps asking | a page's own confirmation answered under an approval nobody read, and a new deployment opening up by omission | permanent |
| Temptation | Growing `actApproval` into a table of which step shapes to ask about — label keywords, per-action tiers, regular expressions | two drifting sets of heuristics, one here and one in the reviewer, and the "no page-semantics heuristics in the engine" line crossed sideways | permanent |
| Red line | No listener may rewrite this package's `ask` into an allowance, and no cross-package channel carries "already judged" outside the type system | "who may ask a person" becoming a function of registration order | permanent |
| Ceiling | `judged` promises only that the decision is handed over. It does not promise the reviewer is right, does not promise a card count, and the guard proves a name is mounted rather than that anything was reviewed | reading the setting as a safety argument, or tuning a reviewer to hit a card-count target | permanent |
| Assumption | The value of `judged` rests on a composition that really does review `content_act` earlier on the waterfall. The guard checks the weakest observable form of that — a name | a `judged` row silently running every page action with nothing between the model and the page | permanent; the guard is what makes it so |

## Consequences

- A deployment at the default sees no change of any kind: same card, same sentence, same order.
- Under `judged`, a set of steps the waterfall allowed runs with no card, and a `deny` from anywhere on the chain still refuses it. The step list is on the call card either way, because `presentCall` is unchanged.
- What a reviewer's own `ask` shows the user depends on the gate. With the shipped 0.2.0 build it shows nothing here, because that build returns from its ask branch without delegating and this listener never runs. Once the 0.3.0 change lands, a reviewer's `ask` reaches the user in the reviewer's own words — except on a `dialogs: "accept"` call, where the carve-out replaces it with the sentence composed here, which is the sentence the record is written against.
- Under `judged` with the reviewer absent, every call of `content_act` is refused. That is the intended failure and it is loud in the model's own transcript.
- Under the console's 完全放开 preset, a reviewer's `ask` is still auto-rejected before any answerer runs: `ApprovalService.decide()` resolves `never` to `'rejected'` ahead of dispatch (`packages/interaction/user-approval/src/index.ts`, `decide()`), and the comment there states why no listener-shaped gate can sit in front of it. `judged` does not reach that, and `dialogs: "accept"` under that preset is refused for the same reason. Which preset the console ships, and whether that one keeps `approval: never`, is a separate question the owner is deciding on its own.
- The gate's 0.3.0 change — delegating in the ask branch — is what makes a reviewer's `ask` reach this listener at all. Until it lands, a `judged` deployment's `dialogs: "accept"` call is refused by the body whenever the reviewer asks. The carve-out is correct either way; the gate is where the other half is fixed.

## Testing

`packages/experimental/content-frame/tests/content-act-tool.client.spec.ts` drives every branch through the real tool registry rather than asserting about the listener: `always` asks (the cases that were already there); `judged` with ordinary steps returns the waterfall's allowance and writes no dialog record; a downstream `deny` and a downstream `ask` each carry through unchanged; `dialogs: "accept"` is asked in this package's words and the call succeeds, which is the record having been written; the reviewer's absence refuses the call and records nothing; unreadable arguments and a call past `maxSteps` still reach the tool's own refusals. The reviewer is a real cordis plugin mounted under the name, registered with `prepend: true` the way a deployment's own is, and one case unmounts it mid-composition — the case the per-call lookup exists for. The refusal is walked by `tests/self-contained-copy.client.spec.ts` with every other sentence. `tests/content-read-routes.client.spec.ts` pins both load failures and the pair that boots. Per-file coverage stays at 100%.

The guard was proved by removing it: with the registry check skipped, the absent-reviewer case fails, and the call reaches the body and is refused for having no console rather than for having no reviewer — which is the whole failure this closes.

**No snapshot scenario was added, and the reason is that this repository cannot run one.** The corpus wants a keyless replay through a real runnable example, and `judged` is only meaningful with a reviewer on `tools/pre-execute`; no plugin in this repository is one, and the shipped reviewer is an out-of-repo, tarball-only plugin a web scenario cannot install. Building the composition would mean a new published test-support package whose plugin allows every call, a second column overlay restating the first (the scaffold takes exactly one patch layer), a second copy of the `content-act` scenario spec, and a keyed recording — to pin a transcript whose only difference from the recorded `content-act` scenario is an approval round trip that did not happen, against a reviewer that reviews nothing. The default path is unchanged, so the six recorded web scenarios replay byte for byte. What a console proves instead is the deployment half, the way [the classification note](../architecture/2026-09-06-content-tools-review-gate-classification.md) records for the gate.
