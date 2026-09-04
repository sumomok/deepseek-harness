# Agent Note: asking the user to change the model a picture needs

Status: implemented

English | [中文](2026-09-05-content-image-model-switch.zh.md)

## Problem

[The picture-read note](2026-09-04-content-read-image.md) put a gate in front of `content_read_image`: a session whose route does not declare image input is refused before anything is exported, because a stored picture is permanent and a text-only route drops the image block from the request after the pixels are already on disk. The gate is right and the failure it prevents is real.

It also stops the user. A console user asks the agent what the picture on the page is; the session happens to be on `deepseek-v4-flash`; the model answers with a sentence of its own about a route that does not take pictures. What the user wanted is one model selection away, and nothing in that answer says so — the refusal deliberately names no remedy, and naming one would break [the self-contained-copy rule](2026-09-04-self-contained-tool-copy.md).

A session sitting on a text-only route is the normal case rather than the odd one. The seeded session starts where its own log put it, the deployment default is whatever the deployment set, and a session moved to a strong text model for the rest of a conversation stays there. The gate fires whenever any of those is true and the page happens to draw something.

Two facts made the refusal worse than it needed to be. The gate read the session's logged request header and the agent's options, and not the model selection the console had already made — so a user who changed the model in the picker and asked again was refused anyway, until some request consumed the selection. And `content_read_image` declares itself safe to run beside its siblings, so two picture reads in one step both hit the gate at once.

## Decision

The gate keeps its position and gains an exit. `access/model-switch.ts` owns it now, and it has three endings:

1. The route declares image input — the read runs, as before.
2. The route does not, and some configured route does — one card goes up in the console asking whether to change the session's model, listing every route that can look at pictures. Where the user chooses one, the session is moved to it and the read runs.
3. Anything else — the call is refused and nothing is changed.

The card is asked where the modality check was asked: in `execute`, before `awaitRead` opens the wait and before any browser is asked to draw. That position is the whole reason a card is possible here at all — a declined change must leave no stored picture behind, and the read's own claim deadline is three seconds while a card can stand for minutes.

**Three tiers for the route.** `effectiveRoute` reads what [`selectionFor`](../../../../packages/api/session-controller/src/agent.ts) reads, in the same order: a `model/selection` no request has consumed, then the session's logged `request/header`, then the agent's options. An absent `inputModalities` is a negative answer at every tier.

**One decision at a time per session, and one card per session.** Route decisions for one session are serialized through a `WeakMap`, so the second of two parallel reads runs after the first has changed the model and reads that change as its own first tier — it passes without a second card. A user who answers with anything other than a route is recorded in a `WeakSet`, and that session's later reads refuse without asking again; the mark suppresses the card and never a pass.

**The change goes through `ctx.sessionController.selectModel` and nowhere else.** It appends `model/selection`, installs the selection on the live agent, and lets the console's picker and the `modelSelection` projection follow. That call also saves the choice as the deployment's default (`agentDefaultModel.saveSelection`), which is a consequence this package does not control and states below.

**The same request the tool result reaches.** `installModelSelection` hooks `system-prompt/assemble` and `agent/request`, and both run once per step rather than once per turn ([`agent-loop`](../../../../packages/core/agent-loop/src/agent.ts)). The step that carries this tool result back to the model is therefore already on the new route, and its system prompt already names the new model — which is why the tool result says nothing about the change.

**The card lists what the deployment claims.** `imageCapableRoutes` walks `ctx.llm.listProviders()` and `listModels(provider)`; the `modelCatalog` projection the console's picker renders carries no modality and cannot answer this. A provider whose catalogue throws is left out and the rest of the card stands. Catalogue membership is advisory — whether a route accepts a request is settled by `resolveCallConfig` inside `selectModel`, and its refusal reaches the model as `routeSwitchRefusal`.

**What the model is told never mentions the card.** A declined change, a composition with nobody to ask, and a card the user closed all answer with the refusal the read already had: `The session's model "X" does not declare image input.` It is still true, and it gives the model no handle to put the card up again. Two refusals are new: one for a deployment where no configured model takes pictures, and one for a change the host would not make.

### The layering this crosses

`@deepseek-ai/dsh-api-session-controller` is a BFF-layer package, and until now nothing outside `packages/api/remotes`, `packages/bundle/web-app` and the `packages/client/ui-*` row depended on it. This package is the first host plugin to consume one of its services. The line held: only `selectModel` is called, only through the public service, and the only import is a type-only one from the browser-safe `/types` face, for the model-selection vocabulary and the `modelSelection` projection key.

The host face is out of reach and stays that way. This package's own program is a Client face, and `scripts/project-reference-faces.ts` requires a Client face entering a split package to enter its client half — which is what carries `/types` and does not carry the `ctx.sessionController` declaration. The service is therefore reached through the `get(name: string): any` overload cordis declares for names outside the typed Context surface, and `RouteSwitcher` is what gives the call back its types. `scripts/package-dependency-policy.ts` exempts `packages/experimental/` from the layering check, so nothing mechanical stops the next such dependency; this section is the record that it was a decision.

### The gate

Five mechanisms, each against the same five blanks. A boundary with no failure it prevents is noise and is not listed; every one listed is marked permanent, or deferred with the trigger that reopens it.

#### M1 — the gate asks and changes, instead of only refusing

- **0 — what a settled principle already answered.** "Plugins, not loop changes" said no to touching `agent-loop`: this is a tool body and two consumed services. "Misconfiguration fails loud at the earliest resolvable point" put the card where the refusal already was, before the wait opens. This package's own rule that reads need no approval said no to an approval gate — and `ApprovalOutcome` is allowed-once/rejected/cancelled/unavailable, which cannot carry a choice among N routes. "A capability seam is three roles" said no to declaring a new seam: this change is a Consumer of `userQuestions`, `sessionController`, `llm` and `sessionProjections`, and of nothing else.
- **1 — new surfaces: 9.** Two modules ([`model-switch.ts`](../../../../packages/experimental/content-frame/src/access/model-switch.ts), [`switch-text.ts`](../../../../packages/experimental/content-frame/src/access/switch-text.ts)); `ModelRouteServices` with four narrowed service faces in place of `ModelRoutes`; the first route tier; the per-session decision chain; the decline mark; two refusals; two type-only dependencies. Zero `Config` fields, zero approval registrations, zero session event types, zero locale keys, zero toolviews, zero routes.
- **2 — v0.** The version with no code: a user changes the model in the console's own picker and asks the agent again. It was run first, and it is what found the missing tier — with the gate reading only the logged header, that hand-run path was refused too. Fixing the tier is v0 of this change and is a strictly smaller version of it; the card is what the second half buys.
- **3 — seam or hardcode.** Hardcoded. No `Config` field, no switch, no timeout knob, no cap on the candidate list, no policy for how many times to ask. Two deployments that would set any of them differently cannot be named: there is one deployment line, one question service, and one place a model selection is installed. Reopen when a second deployment wants `content_read_image` without the card.
- **4 — boundary.**

| Direction | The line | The failure it prevents | Standing |
| --- | --- | --- | --- |
| Neighbour | Model selection belongs to `sessionController`. This package appends no `model/selection`, installs no second selection reference, and hooks no `agent/request` of its own. | Racing the listeners the session controller already installed, and leaving the console's picker and the projection behind the route in use. | permanent |
| Contract | The gate runs before `pending.open`, and `awaitRead` is unchanged. | A card standing for minutes while a three-second claim deadline expires, ending the call as `unclaimed`. | permanent |
| Temptation | Growing this into a general "a tool asks the user when it is stuck" opening. It asks one question, and only where the route takes no picture. | Every content tool putting cards up, with approval and question flows mixed into one. | permanent |
| Red line | Nothing is captured, exported, posted or stored before the user has chosen a route. | A picture the user declined kept forever in `$DSH_HOME/attachments/`, which collects nothing. | permanent |
| Ceiling | No promise that the chosen model reads this picture well, that the card follows the console's language, or that anything changes back. | "It still could not tell me what it was" read as a defect of this change. | permanent |
| Assumption | The composition mounts `llm`, an answerer for `userQuestions`, `sessionController`, and the `modelSelection` projection, and the caller is a live root agent. Any of them missing is the old refusal, not a workaround. | A card nobody can see, and a tool hanging on an unanswered waterfall. | permanent |

#### M2 — the card itself

- **0 — what a settled principle already answered.** "Prefer maintained dependencies over hand-rolling" said no to drawing a card here: `ask` already owns the waterfall, the agent scope, the cancellation and the console takeover. "Trust TypeScript at typed same-process boundaries" does **not** reach the answer — the selected label comes back from a browser across a remote waterfall, so a label that is not one this card offered is treated as no route rather than asserted into one. The fork's zero-upstream-change rule said no to adding an `AskUserQuestionIntent` member. The product rule that a console user reads no jargon fixed the wording.
- **1 — new surfaces: 3.** The card's copy, `switchQuestion`, and the label-to-route map the answer is read through.
- **2 — v0.** One question, one option per route, and one option that changes nothing. Smaller was considered — no decline option, leaning on the composer's own skip control — and rejected: declining is an answer to this question, and skip is a control every question carries.
- **3 — seam or hardcode.** Hardcoded: no intent, no multi-select, no custom rendering, no second question.
- **4 — boundary.**

| Direction | The line | The failure it prevents | Standing |
| --- | --- | --- | --- |
| Contract | A label is the answer's identity, and every label on one card is unique: `厂商：模型`, plus the model id wherever two would read alike. | Choosing one model and being moved to another. | permanent |
| Temptation | A second question on the same card — resolution, format, "remember this". | One tool call turning into a questionnaire. | permanent |
| Red line | No attachment id, provider id, model id, or modality vocabulary in the card's own copy. Only display names, and a model id only where two options would otherwise read alike. | A console user reading this package's internals. | permanent |
| Ceiling | Host-side Chinese literals, the same as the `content_act` approval request; the card does not follow the console's locale. | Chinese copy in an English console read as a defect. | deferred — trigger: a real locale service on the host, or a non-Chinese-speaking customer |
| Assumption | The card renders under the server-layout composition. Probed before this was written: a question asked through `ctx.userQuestions` on a seeded content-column session appears as `[data-question-key]`, is answered by a click, and returns the exact label. | A card raised into a console that shows nothing, leaving the tool waiting for its own cancellation. | permanent |

#### M3 — where the model change lands

- **0 — what a settled principle already answered.** "Explicit > implicit at package boundaries" said to call the public `selectModel` rather than reach into the controller's own agent registry. "Misconfiguration fails loud; never silently skip a missing referent" said that an absent `sessionController` is a refusal, not a pretended change. "Opaque cross-boundary ids are branded" made the session id `agent.session.header.id` rather than a composed string. The fork's zero-upstream-change rule said no to opening a lower-level selection seam upstream.
- **1 — new surfaces: 2.** `RouteSwitcher`, and the type-only dependency on the session controller.
- **2 — v0.** The single call. Three smaller versions were tried on paper and all fail: see Alternatives.
- **3 — seam or hardcode.** Hardcoded: one landing point, one method, no retry, no rollback.
- **4 — boundary.**

| Direction | The line | The failure it prevents | Standing |
| --- | --- | --- | --- |
| Neighbour | Only `selectModel`, only through the service, and no runtime import of the BFF package. | An experimental plugin treating the BFF layer as a toolbox, inverting the layering for good. | permanent |
| Contract | The change is durable for the session, and `selectModel` also saves it as the deployment's default, so a session opened later starts on it. | A user expecting a one-call change and finding tomorrow's new session on a different model. | permanent |
| Temptation | Changing the model back when the read finishes. | Two silent selections per read, with neither the user nor the model knowing which route they are on. | permanent |
| Red line | The route is never changed by any other means. | The projection, the picker and the log disagreeing with the route actually in use. | permanent |
| Ceiling | Provider and model only. `reasoningEffort` is left to `resolveCallConfig`'s own default for the new route. | "The reasoning level disappeared when it switched" read as a defect. | deferred — trigger: a vision route whose default effort is visibly wrong for it |
| Assumption | `sessionController` is composed with `agents`, `sessionProjections` and `agentDefaultModel`, as its own inject list requires. A headless or ACP composition has none of them and gets the old refusal. | Putting a card up in a deployment with no console. | permanent |

#### M4 — counting the routes that can look at pictures

- **0 — what a settled principle already answered.** The session controller's own catalogue isolates one provider's failure rather than emptying the list, and that stance is copied here. "No hardcoded tunables in plugins" said no to a candidate cap: a cap is a deployment-varying number, so it is a `Config` field or it does not exist, and it does not exist. "An empty `catch` names what it swallows" named this one: one provider's catalogue could not be read.
- **1 — new surfaces: 2.** `imageCapableRoutes` and `optionLabels`.
- **2 — v0.** Those two functions. Smaller — reusing the `session/modelCatalog` RPC the console's picker already renders — cannot work: that projection carries `{id, name, description?, reasoning?}` and no modality.
- **3 — seam or hardcode.** Hardcoded: no ordering, no scoring, no recommendation, no memory of last choice, no cap.
- **4 — boundary.**

| Direction | The line | The failure it prevents | Standing |
| --- | --- | --- | --- |
| Contract | One criterion: `inputModalities` contains `image`. Absent is a no. | Offering a route on a guess, then having the picture replaced by a placeholder in the request. | permanent |
| Neighbour | The catalogue is `llm`'s. Nothing is cached, completed or hardcoded here, and no model name appears in this package. | A deployment changing its catalogue while the card still offers a model it no longer has. | permanent |
| Temptation | Publishing this count as a general "which models can see" API or projection. | A second catalogue growing beside `modelCatalog`. | permanent |
| Ceiling | Every image-capable route is listed, however many. A deployment with dozens of vision routes gets a card with dozens of options. | An unusable card read as a defect of the enumeration rather than of the deployment. | deferred — trigger: a real deployment with more than eight candidates |
| Assumption | `listModels` is what the deployment claims, not route validation; the validation is `selectModel`'s. | A card offering a route that cannot be switched to, with nobody saying why. | permanent |

#### M5 — the first tier, the decision chain, and the decline mark

- **0 — what a settled principle already answered.** "Prefer symmetry for parallel values; unexplained asymmetry usually signals a missed extraction" is what made the missing tier a defect rather than a choice — `selectionFor` reads three and this read two, for no stated reason. "Runtime invariants assert owned relationships" kept the chain and the mark out of the log and out of every projection: they are this package's own runtime state. The defensive-patterns rules on lifecycle put both in weak collections keyed by `Session`.
- **1 — new surfaces: 3.** The first tier through `RouteSelectionState`, `serializeDecision`, and the decline mark.
- **2 — v0.** The tier alone, which is what the hand-run probe needed. The chain and the mark cannot be dropped from the shipped version: without the chain, two parallel reads in one step raise two cards; without the mark, a model retrying a refused read raises one card per retry. All three together are what makes "asked once" a property anything can check.
- **3 — seam or hardcode.** Hardcoded at one card per session. Once per turn would be better, and `ToolExecution` carries no turn or step identity to key it by; adding one is a change to the tool runtime.
- **4 — boundary.**

| Direction | The line | The failure it prevents | Standing |
| --- | --- | --- | --- |
| Contract | The first tier reads `pending` only, never `lastUsed`, which is the selection a request already consumed and is the second tier by another name. | Counting one selection twice, and reading a route the session has already left as still current. | permanent |
| Temptation | Reusing the decision chain to order anything else — an export, a post, a report. | One lock turning a parallel-safe channel into a serial one. | permanent |
| Red line | The mark suppresses the card and never a pass. | A user who changed the model in the console still being refused. | permanent |
| Ceiling | The mark is in memory: a reloaded session or a restarted host asks once more. | "I said no and it asked again" read as a defect rather than as the cost of one card. | deferred — trigger: a user reporting being asked again after a restart |
| Assumption | `stateOf` reflects an appended selection synchronously, because it folds the session's own log. | The second of two parallel reads raising a card for a change the first already made. | permanent |

## Alternatives considered

- **Change to the first image-capable model without asking.** Rejected: which model a conversation runs on is the user's choice — the base bundle's own system-prompt rule reserves `ask_user_question` for exactly that — and this change is durable and also moves the deployment default.
- **Tell the model to ask the user to switch, in the refusal.** Rejected: a failure states why it was refused and never names a remedy or another tool ([the self-contained-copy note](2026-09-04-self-contained-tool-copy.md)).
- **Put it on `user-approval`.** Rejected: `ApprovalOutcome` is allowed-once, rejected, cancelled or unavailable, and cannot carry a choice among N routes.
- **Add an `AskUserQuestionIntent` member so the console can draw a model-switch card.** Rejected: it changes two upstream packages, against this fork's zero-upstream-change rule, and the generic option list is enough.
- **Draw the card in this package's own browser half.** Rejected: it would contend with `ui-user-questions` for the composer takeover and would need a second answer path back to the host.
- **Append `model/selection` and stop there.** Rejected: a live agent's selection is read from the projection once, when it is installed, and is an in-memory value afterwards; the event does not move it.
- **Call `installModelSelection`, or hook `agent/request` here.** Rejected: neither writes the event, so the projection and the console's picker fall behind the route in use, and both would sit beside the listeners the session controller already installed.
- **Enumerate through the `session/modelCatalog` RPC.** Rejected: that projection carries no `inputModalities`, so it cannot answer which model can look at a picture.
- **Let the change take effect on the next turn.** Rejected as unnecessary: `system-prompt/assemble` and `agent/request` both run once per step, so the step carrying this tool result back is already on the new route. No deferred-effect design is needed and none exists.
- **Skip the per-session serialization.** Rejected: `isConcurrencySafe` is true, so two picture reads in one step raise two cards and make two selections.
- **Skip the decline mark.** Rejected: a refused read is one the model may retry, and each retry would raise another card.
- **Decode the picture — a QR or barcode reader in this package.** Rejected by the same red line the picture-read note draws: nothing is read out of the picture on the way past.

## Consequences

**The change is durable, and not only for this session.** `selectModel` appends `model/selection` and then saves the selection as the deployment's default, so a session opened afterwards starts on the chosen model. The card says the conversation will keep using it; it does not say the default moved. Both facts are in the README and here.

**The session's remaining turns run on a model the user did not choose for them.** A vision model may be weaker than the one the conversation was on. Nothing changes it back; the user does that in the picker.

**Two more events per accepted change, and no new event type.** `model/selection`, then the `reason: 'change'` `request/header` that consumes it. `SESSION_FORMAT_VERSION` is unchanged, no projection's `stateVersion` moves, and `contentAccess` is untouched.

**The question itself is in no log.** `user-questions` has no `SessionEventMap` member, so a replay cannot see that a card was raised or that a user declined one. A recorded scenario reproduces the answer by clicking it.

**A host plugin now depends on the BFF layer.** The first one; the line it holds to is in the Decision above.

**The card is single-language.** Host-side Chinese, like the `content_act` approval request, in a console set to any language.

**Nothing changes for a composition without a console.** Headless, ACP, and a delegated child agent all reach the same refusal the read gave before this change, because `ask` refuses a child caller outright and the two services are absent in those compositions.

## Testing

`tests/content-model-switch.client.spec.ts` drives the gate against stood-in services: the three tiers separately and against each other, a route that passes without the catalogue being read or anyone being asked, an empty candidate list, a composition missing the asker or the switcher, the card's payload verbatim against the copy this note records, the model change with its exact request, every answer that is not one of the offered routes (skipped, free text, the decline option, an unknown label, two labels, another question's id, and an unanswered card), a cancelled call, both arms of a refused change, the catalogue enumeration with one provider failing, the three labelling cases, and the two runtime facts the mechanism rests on — two parallel gates producing one card and one change, and one card per session however often the model retries.

`tests/content-read-image-tool.client.spec.ts` holds the order the whole design rests on: with a card that nobody answers, `PendingCalls.open` is never called, before the cancellation and after it. `tests/self-contained-copy.client.spec.ts` walks `switch-text.ts` beside the two model-facing text modules, so the card's copy is held to the same rule. `src/` stays covered per file at 100%.

One Web scenario backs it: `apps/web/tests/content-read-image-switch.e2e.ts`, over the same composition, application and preset as [the picture scenario](2026-09-04-content-read-image.md), and differing in one thing — it does not select a route on the seeded session, so the session stays on the `deepseek-v4-flash` its seed logged. The spec asserts that route and its absent image modality before it drives anything, waits for the card, pins the card's accessibility snapshot as `card.expected.md`, clicks the vision option and submits, and then asserts that the answer describes the picture, that a `model/selection` was appended, and that a `reason: 'change'` request header on the vision model followed it. The click is the test's own action in record and replay alike, the way the approval scenario's is. The scenario's request headers differ from the picture scenario's from the first one, so it carries a `header.class` and a pin of its own and grows two sidecars with a `<!-- request/header change 1 -->` section in them. Record it with a key:

```sh
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-image-switch.e2e.ts
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-image-switch.e2e.ts
```

The refresh is keyless and is not optional: `record` writes only `session.jsonl`, and the two sidecars and `card.expected.md` are written by the refresh. The spec skips itself while `snapshots/web/content-read-image-switch/session.jsonl` is absent, so the scenario and its recording may land in different changes without turning a keyless lane red.
