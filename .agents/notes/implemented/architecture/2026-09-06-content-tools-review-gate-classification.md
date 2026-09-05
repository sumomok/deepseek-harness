# Agent Note: the content column's reads are classified, not judged

Status: implemented

English | [中文](2026-09-06-content-tools-review-gate-classification.zh.md)

## Problem

The service-line console runs `@haoran/dsh-llm-permission-gateway` in front of every tool call, and on a console carrying its 0.1.5 build the content column's reads were refused. Three facts of that build produced the refusal together.

**Every unlisted tool went to the judge.** 0.1.5 held one classification table, `readOnlyTools`, whose default was seven names — `read, read_image, glob, grep, todo_write, plan, ask_user_question` (`lib/index.js:627-635`). There was no walled-tool step and no review mode: the decision order was red-line scan, `alwaysAsk`, `readOnlyTools`, argument-length cap, cache, judge (`lib/index.js:749-823`), so `bash` in a `workspace-write` sandbox went to the judge as readily as `content_read_dom` did.

**The judge was shown the tool's name and its arguments and nothing else.** The user prompt is `{tool, arguments}` serialized into a fence that says the block is data rather than instructions (`src/prompt.ts:79-81`, `:126-138`; 0.1.5's built copy is line-for-line the same). No description, no parameter schema, no owning plugin. So `content_read_dom` with `{"scope":"e1"}` was seven characters and a value, and the model read the name: a DOM read with a scope, judged as an exfiltration. The tool's own description says the opposite — `src/access/text.ts` has it print the page's own markup under one ref and never print a password box's value — and the judge saw none of it.

**A deny was a deny, and it was cached.** 0.1.5's `applyVerdict` returned `{kind: 'deny'}` for a deny verdict (`lib/index.js:826-838`), and every verdict is stored per agent under `${tool} ${argumentsDigest}` (`lib/index.js:800-806`, `:818`). The second identical read reused the stored refusal without asking the model, which is why the console showed the same refusal every time rather than an occasional one.

Two more facts explain why the console's own settings did not help. Classification never read the sandbox mode in 0.1.5 — `sandboxPolicy` is not consulted anywhere in that build — so switching the access preset changed the operating-system walls and left the gate's branch untouched. And `reasonLanguage` defaulted to `English` there (`lib/index.js:654`), which is why the refusal arrived in English on a Chinese console.

## Decision

**The classification is written in a deployment overlay, because `Config` is the gate's only classification channel.** The gate registers no service, declares no event, and merges no declaration into `Context`; the three `Config` lists — `readOnlyTools`, `walledTools`, `alwaysAsk` (`src/index.ts:177-197`) — are the whole surface, read by one pure function that runtime and offline replay share (`src/walls.ts:80-89`). `packages/experimental/content-frame/overlay/permission-gateway.patch.yml` is that row: the five content reads joined to `content_show` in `readOnlyTools`, passed as one more `--patch` beside the column overlay.

**`content_act` is not on the list.** It drives the page, so the gate reviews every call of it.

**Ratified by the owner on 2026-09-06, not decided here.** That the judge reviews `content_act`, and that only a dangerous page action puts a card in front of a person, are the owner's rulings; the mechanism that decides which action is dangerous is a separate slice. The earlier review-gate rulings taken for rc.31 are the owner's too, and two of them are load-bearing here: the read-only list is the instrument for classifying what should not be judged, and the judge never refuses outright.

**No seam was built between this package and the gate.** Two settled principles say no, and the first is enough. Out-of-repo plugins reach this repository only as `pnpm pack` tarballs vendored into a deployment closure, never as a link — so a repository package cannot depend on the gate at all, in either direction of the import. And a capability seam is complete or it is not built: there is one consumer today, and the second instance of this same problem — a screenshot plugin's tools — was already solved by adding names to the gate's own defaults.

**The overlay copies rather than extends.** A patch replaces the targeted row's complete `config` value (`vendor/include/src/index.ts:121-124`), so the row restates `provider` and `model`, which the gate rejects empty, and writes out its eleven default read-only names. Nothing in this repository asserts those eleven: the gate pins its own defaults in its own tests, and a second copy under assertion would be a second source of truth for a value this repository does not own. What is pinned is the half this repository owns — every tool name the package registers, imported from the module that declares it, and `content_act`'s absence.

**A deployment without the gate loses nothing by passing the file.** An id that matches no row warns and continues (`vendor/include/src/index.ts:110-114`); the declared `name` turns a mistyped id into a name-mismatch warn rather than a silent hit on the wrong row (`:116-118`).

## Decision gate

**0. Which settled principle already says no?** None. "No hardcoded tunables in plugins" points the other way — which tools count as read-only is a deployment-varying choice and belongs in yml, which is exactly where the gate put it. The upstream-zero-change rule is satisfied: no code moves. The one principle this grazes is "misconfiguration fails loud": a deployment that passes the overlay without the gate installed gets a warn line, not a failure, and cannot be made to fail loud from this side. The file names that in its own comment.

**1. How many new surfaces? Two.** One overlay file on the configuration plane, and one deployment-side version change (the console's vendored gate moves from 0.1.5 to 0.2.0). New tools 0, tool parameters 0, `Config` fields 0, routes 0, session events 0, projections 0, approval gates 0, dependencies 0, system-prompt lines 0. `SESSION_FORMAT_VERSION` and the `contentAccess` `stateVersion` are untouched.

**2. The smallest version that shows the judgement is better.** The whole change is one row, so the smallest version is the change: on the console, a page read (`content_read` then `content_read_dom`) completes with no approval card and no judge round trip, and a click (`content_act`) puts up the card that lists each step by its label.

**3. Seam or hard-wired? Hard-wired.** No registry, no service, no per-tool metadata. Cutting a seam would need two consumers that are really about to change, and there is one; the other instance of the problem is already answered by the gate's defaults. Review trigger: a second repository package needing its tools classified, or upstream `ToolDefinition` growing a review field that any gate could read.

**4. Boundaries.**

| Direction | The line | The failure it prevents | Term |
|---|---|---|---|
| Neighbour | Classifying a tool is the deployment's judgement, not this package's and not the gate author's, so it lives in an overlay a deployment chooses to pass | a repository package importing a private third-party plugin's types, which has no supported route in either direction | permanent |
| Contract | The row depends on the field name `readOnlyTools` and on whole-`config` replacement; the gate renaming either silently empties the classification | the reads drifting back in front of the judge with nothing failing — the pin test is what fails instead | permanent |
| Temptation | Adding `web_fetch` or a screenshot tool to the same list to save judge round trips | classifying as read-only two calls that really do leave this machine | deferred; trigger: measured judge cost over budget, reopened with each candidate argued on its own |
| Red line | `content_act`, or any later tool that writes the page, never joins this list | a tool that clicks buttons being allowed without either the judge or a person seeing it | permanent |
| Ceiling | The row does not claim the content tools are safe; it claims only that the judge does not decide them a second time. The gate's red-line scan still runs before every skip (`src/index.ts:436-440`) | reading the list as a safety argument rather than a routing one | permanent |
| Assumption | Holds with the gate at >= 0.2.0 and a deployment that configured `pageAccess`; under 0.1.5 the same row would allow the reads with no deny-to-ask backstop under it | the classification being carried onto an older gate where it is strictly more permissive than intended | deferred; trigger: a change to the vendored gate version |

## Alternatives considered

**Put `content_act` on `readOnlyTools` too.** It has a human gate of its own: `registerActApproval` returns a card naming every step by label, and the gate's own default list carries `ask_user_question` for the same reason — a tool whose whole effect is to put something in front of the person at the keyboard. Judging `content_act` costs a round trip on the good path and, on an `ask` verdict, replaces that step-by-step card with one sentence, because `alwaysAsk` and an `ask` verdict both return without calling `next()` (`src/index.ts:442-446`, `:527-543`) and the package's own listener never runs. The owner ruled on 2026-09-06 that the judge reviews it anyway and that prompting a person is reserved for a dangerous page action. The cost above is the price of that ruling and is recorded here so the trade is visible if it is revisited. See [the content-act note](../feature/2026-09-02-content-act-page-steps.md) for what the card contains.

**Put `content_act` on `alwaysAsk`.** Strictly worse than either of the above: it short-circuits the same way, so the specific card is replaced by a generic one, and it does so on every call rather than on a judged one.

**Add a classification seam to the gate — a service or an event this package registers into.** Blocked before cost enters: a repository package cannot import a private, unpublished, tarball-only plugin's types, and a second cordis in the tree is what the tarball rule exists to prevent. It is also a one-consumer seam. If the shape is ever built, the right one is upstream — review metadata on `ToolDefinition` that any gate reads — not a registry private to one gate.

**Fix the judge instead: show it the tool's own description.** This is a real fix and it is being built, in the gate rather than here. The gate already injects `tools` and the registry exposes `get(name, scope)`, so the mechanical cost is one lookup and one field in the judge's prompt, fenced with the arguments rather than placed in the system prompt. It treats the next tool as well as this one, which classification cannot. It does not replace classification: a judge that reads correctly still spends one model round trip per call, and the console's measured rate is tens of reads per task.

**Change the access preset.** Does nothing. 0.1.5 never read the sandbox mode, so no preset reaches the gate's classification; 0.2.0 reads it for walled tools only.

## Consequences

- The five content reads and `content_show` skip the judge on a console that passes the overlay. `content_act` is judged, which costs one round trip per set of steps and, on an `ask` verdict, replaces the step-by-step approval card with the judge's sentence.
- The console's gate must be at 0.2.0 or later for this row to be safe. On 0.1.5 it is more permissive than intended, because that build has no deny-to-ask downgrade under it.
- Moving to 0.2.0 changes three things the console has never run: walled tools skip the judge outright, a deny becomes an ask and is recorded as downgraded (`src/index.ts:527-543`), and the sandbox-escalation approval answers on the model's behalf. The gate's patch also rewrites the whole `permission.presets` row, which is how a previous version overwrote the console's own preset labels, so a deployment that customizes those labels restates them in a layer after the gate's bundle.
- The reason language changes with the version rather than with this row: 0.1.5 defaults to `English` and 0.2.0 to Simplified Chinese.
- Renaming any of the six classified tools fails `packages/experimental/content-frame/tests/permission-gateway-overlay.client.spec.ts` before it can reach a console.
- Nothing here is a repository dependency on the gate. The overlay is a file a deployment may pass or not, and the package builds, tests, and runs identically either way.

## Deferred

Two changes belong to the gate and are being made there for 0.3.0: the judge reading each tool's registered description, and the judge route becoming a setting rather than two required `Config` fields. The second retires the `provider` and `model` lines this overlay restates. Neither is blocked on anything in this repository.

## Testing

`packages/experimental/content-frame/tests/permission-gateway-overlay.client.spec.ts` parses the overlay under the include plugin's `entryListSchema` and asserts the targeted id and package name, the two restated fields as non-empty strings, every classified tool name imported from `src/access/wire.ts` and `src/tool.ts` rather than written out, no duplicate name, and `CONTENT_ACT_TOOL_NAME` absent. The absence assertion was checked against a deliberately broken file: adding `content_act` to the list fails that case and only that case. The package keeps per-file 100% coverage; a yaml pin adds no source.

No end-to-end case covers the gate. The web lane is keyless replay, and the gate reaches a model on every path that is not a classification skip, so covering it would mean adding a fake provider row to the composition to observe a path that by construction never calls a model. What a console proves instead is the deployment half: the gate's verdict log records `readOnly` for the classified reads, `walled` for `bash`, and a judged entry for `content_act`.
