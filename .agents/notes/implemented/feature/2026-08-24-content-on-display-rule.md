# Agent Note: the rule that a follow-up lands on the content already on display

Status: implemented

English | [中文](2026-08-24-content-on-display-rule.zh.md)

## Problem

A user with a chart on screen quoted its caption and asked for a bar series alongside the line. The model minted a second chart id and drew a second chart beside the one the user was pointing at. [The `show_chart` note](2026-08-24-show-chart-supersede-and-inspection.md) records the finding and the first repair: the `id` parameter description now names the trigger instead of only offering reuse.

That repair reaches one tool. The failure does not belong to charts — it belongs to every producer the content surface routes. A page re-shown under a new identity opens a second column entry exactly as a chart does, and the next kind will arrive with the same gap. A parameter description is also the wrong place to state something true of all of them: it is read while the model is choosing arguments for a tool it has already decided to call, and it is invisible to a model deciding whether this is a new piece of content at all.

## Decision

Two layers, because that is what the measurement says. The parameter clause stays exactly as it is, and a second, kind-agnostic statement of the same rule is registered as a system-prompt section by `dsh-experimental-content-surface` — the row that already owns the tool-independent notion of a content entry.

The section text names no chart, no page, no tool, and no argument:

```markdown
# Working with content already on display

When the user refers to something you have already produced and put on display — quoting it, naming its title, or otherwise pointing at it — and asks for a change, update that same piece of content in place through the tool that produced it, reusing its identity, rather than producing a new one beside it.
```

A kind registered later inherits it with no edit here, and each tool's schema keeps saying which of its arguments carries the identity.

### What was measured

Log replay of the session that failed, one arm per candidate repair, ten samples per arm. The decision on each sample is mechanical: does the response reuse `id: "gold-7d"`, the chart the user quoted, or does it mint a new one?

| Arm | Reused the id |
| --- | --- |
| Before any repair | 1/10 |
| `id` description clause only | 5/10 |
| General rule only, at the end of the system prompt, with no chart vocabulary | 8/10 |
| Both layers | 10/10 |

Three things follow. The general rule alone beats the parameter clause alone, so the cheaper-looking single layer is the weaker one. The two are not redundant — together they clear a gap neither closes alone. And the 8/10 arm placed the rule at the **end** of the prompt, which makes position part of what was measured rather than an incidental detail of how the arm was built.

### Where the section lands

`content:on-display` at order `200`, past the documented `100–199` tool-guidance band. The rule is read against whatever each tool just said about its own arguments, so it belongs after all of them, and no section registered anywhere in the repository today takes a higher order — the highest is `190`. The Web e2e asserts the assembled tail against a real composition rather than trusting the arithmetic.

Core's band documentation is unchanged. One experimental row taking the first order past the band is not yet a convention worth writing into `dsh-system-prompt`.

### Optional, and unconditional

The section is registered through `ctx.inject(['systemPrompt'], …)`, matching the projection child beside it: a composition with no prompt registry keeps the extractor table and contributes no guidance. Absence of a system prompt is not a misconfiguration of this row — it is a composition with no model in it — and the alternative would make `ctx.contentSurface` itself unavailable to the projection-only assemblies the package already supports.

It does not consult the extractor table. The rule describes what the user does, not what a kind can draw, so gating it on a registered kind would tie a model-visible prompt to hot-load timing — this registry re-registers on every table change, and a kind row can arrive mid-session — while saving words no real composition ever spends, because the router is never composed without kinds.

### Nothing new is logged

Model-visible ⟺ logged is already satisfied. The assembled system prompt reaches the model through the one rendering path and is recorded in the routed request header, which is what replay and `ctx.tokenMeter` read; a prompt section is reconstructable from the log without a session event of its own. This package still appends none.

## Alternatives considered

**Keep the rule only in the `id` description.** The arm that was already shipped: 5/10, and it cannot be stated once for kinds that do not exist yet.

**Ship only the general rule and drop the parameter clause.** 8/10 against 10/10 for both. The clause also does something the general rule cannot: it says which argument of that specific tool carries the identity.

**Put the section in `vue2-echarts-tool-poc`.** Rejected: one tool would own a rule about every tool, and the second content tool would either duplicate it — a duplicate section name throws — or contradict it. The surface owns the kind-agnostic concept, which is exactly why the rule can be written without chart vocabulary.

**Put it in `dsh-system-prompt` or the deployment persona.** Rejected: a composition with no content surface has nothing on display, and would pay for a rule about nothing. The words are owed by the row that creates the situation.

**Gate the section on at least one registered extractor.** Rejected above: hot-load timing would become model-visible, for a saving no deployment realizes.

**Take an order inside the `100–199` band.** Rejected: the measured arm put the rule at the end, and any value in the band leaves it competing with tool guidance for the last position, decided by registration order — a plugin-load artifact `dsh-system-prompt` already names as a known limitation.

**Reserve a documented "last" band in core.** Rejected for now: one consumer is not a convention, and an experimental row should not move a core contract to seat itself.

## Consequences

About 70 words ride in every request of every turn of every agent in a composition that includes this row, whether or not that session has ever displayed anything. The text is static, so the cost does not grow with the entry stream, and the prompt gains a constant tail whose prefix is undisturbed.

The position is a convention, not an invariant. Any section registered above order `200` moves this one off the end, silently, and the measurement that justifies the wording was taken at the end. The Web e2e is the tripwire; the package README records the gap.

The numbers come from one recorded session and one decision rule. They are strong enough to choose between four candidate repairs and not strong enough to be a general claim about prompt placement; a different failure should be measured again rather than reasoned from this table.

Every content tool the surface routes now inherits a reuse rule it did not write, including tools composed from outside this repository. That is the point, and it is also the risk: a tool whose identity genuinely should not be reused has to say so in its own description, against a general rule that says it should.

## Testing

`tests/prompt-section.spec.ts` holds the expected text as its own literal — importing the constant would pin nothing — and asserts the section is the last assembled section, that the rendered prompt ends with it, that it is contributed with no extractor registered, that disposing the row's fiber withdraws it (HMR safety), and that the registry still mounts with no prompt registry composed.

`apps/web/tests/content-surface.e2e.ts` answers the question a unit test cannot: it boots the shipped Web surface plus the surface overlay and asserts that the last section of that composition's assembled prompt is this one, verbatim. It drives no model and opens no page for that assertion.
