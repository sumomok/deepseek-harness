# Agent Note: Four access modes, folded from the wall and the approval policy

Status: implemented

English | [中文](2026-09-17-gateway-four-access-modes.zh.md)

> Supersedes two decisions of [The review switch leaves the preset table](2026-09-06-gateway-review-switch.md): review no longer ships on, and the preset row is now named for review. What that note records about where the gate sits, what a wall covers, the two red lines, the escalation answerer, and why the row's id never changes still holds.

## Problem

`@haoran/dsh-llm-permission-gateway` 0.3.1 decided what to do with a call from a setting of its own — a switch that shipped `auto` and held under every access mode — while the access mode only told it which tools already had a wall. The mode a person selected and the authority the gate exercised were therefore independent choices, and two of the four combinations were wrong in a way the gate could not see.

Under 完全权限 the gate raised questions nobody could receive. `ApprovalService` resolves every approval request under `approval: never` to `rejected` before any answerer is dispatched, so each `ask` the gate raised there reached the person as nothing at all and the model as `the user rejected tool "<name>"`. A customer on Windows hit this as a `browser_auth` that failed with no prompt and no explanation. That mode's whole meaning is that nothing stops and nothing asks, and the gate was converting it into silent refusals of calls nobody had objected to.

Under 仅可查看 and 工作区内修改 review shipped on, and there the operating system is already refusing the file effects a review would object to. What review bought in those two modes was a model round trip on each call the wall does not reach — a `run_code` program body, a call that leaves the machine, a call that acts with a login — charged in exactly the modes a person selects in order to work without being interrupted.

The row the plugin contributes, `yolo-access`, was named 关闭沙箱（不推荐） and described by what it removes. It is the one mode in which review is not optional: its `{danger-full-access, ask}` pair is no wall plus a person who can still be asked, which is review by construction, and the name said nothing about that.

## Decision

The desktop moves to `@haoran/dsh-llm-permission-gateway` 0.4.3 (tarball sha256 `cd7d6bd1ed97c673e6e2077e2f076927c25b82e4e7695fa7074d27e0418d382b`, 194063 bytes), replacing the 0.3.1 tarball.

**What the gate does to a call is folded from two knobs the harness already has, never from a preset name.** They are read per call: whether the operating system confines file effects, through `ctx.sandboxPolicy.resolve({ session })` and the mounted shell executor's reported `sandboxMode`; and what the session's effective approval policy is, read from the `permissions` session projection where that unit is registered and from `ApprovalService.overrideOf` otherwise, falling back to the deployment default and then to `ask`. A deployment that renames or reorders its presets changes nothing here.

| Wall | Approval policy | Tier | What the gate does |
| --- | --- | --- | --- |
| `read-only`, `workspace-write` | either | `walled` | Reviews what the wall does not cover, and only while its own switch is on |
| none | `ask` | `auto-review` | Reviews every call that is not a local read; its own switch does not reach this tier |
| none | `never` | `full-access` | Nothing at all — no red line, no `alwaysAsk`, no review; every call is delegated and recorded as `unattended` |

**The walled tier's switch covers those two modes only, and ships off.** `config.mode` defaults to `manual`, which overturns the `auto` default recorded on 2026-09-06. The settings section is **审查设置** / **Review settings**, `/review auto` and `/review manual` are the same switch from the composer, and both name the two modes they reach rather than naming themselves. Turning it on buys review of the unwalled calls a confined session still makes, at one model round trip each.

**The row is named 自动审查 and declared third.** This overturns the 2026-09-06 rule that no preset row may name review. That rule was written while review was a switch a person could throw independently of the row; it is not one here — this row's knob pair is exactly what puts a call in `auto-review`, and the walled tier's switch cannot reach it. Its description says the same three things the name compresses: 不设操作系统围墙。每一步先交给审查模型看，拿不准的弹给你确认；动到审查功能自身文件、或一边读凭证一边外发，一律直接拒绝。 Declaration order is menu order, and the table now reads walls, then no walls but still asked, then no walls and never asked. The id stays `yolo-access` and the knob pair stays `{danger-full-access, ask}`, for the stored-`defaultPreset` reason the 2026-09-06 note owns.

**A question nobody can answer is a refusal the gate signs itself.** Where the calling session's own effective policy is `never`, each of the five steps that would raise an `ask` — `alwaysAsk`, an oversized call, a review failure under `onFailure: ask`, an `ask` verdict, and a downgraded `deny` — is still put down the rest of the `tools/pre-execute` waterfall and then answered `{kind: 'deny'}`, carrying the step's own sentence plus one saying nobody could be asked. A `deny` or a more specific `ask` further along the chain still wins. Records carry `delegated` and `humanReachable`.

**A delegated call is governed by the session it was delegated from.** `@deepseek-ai/dsh-subagent` pins every in-process child at `approval: never` wherever the approval capability is composed and seeds the parent's sandbox override beside it, so a child of a wall-less session carries the `full-access` pair whichever mode the person actually selected; without this reading, one `delegate` would put every subagent call past the review, past `alwaysAsk`, and past both red lines. Delegation is `header.origin === 'subagent'` and nothing else — `parentSession` is the session a conversation was **forked** from — and the tier is read by climbing `session.header.parentSession` through `ctx.agents.get()` while the session it stands on is itself a subagent child. A lineage that does not resolve folds as if a person could be asked, so a standing wall is still a wall.

**The two red lines hold wherever the gate decides a call**, the walled modes with review off included, and nothing in the plugin runs under `full-access`. The self-modification line now compares absolute paths only and leaves a relative argument to the literal spellings it lists, because resolving one against this process's working directory made every argument carrying a separator match whenever `dsh` was started inside a protected directory. The decision record is deliberately outside the protected set: guarding it meant reading `verdictLog`, and a red line a `Config` field can move in both directions is not a red line.

**The desktop's composition layer is unchanged.** The `llm-permission-gateway` row in `apps/desktop-app/cordis.patch.yml` still restates only `provider` and `model`, because those remain the only two required fields of the plugin's `Config` and the only two its own patch layer writes, and the plugin's shipped route is still the retired `deepseek-v4-flash` that row exists to redirect.

### Retirement

This row, the walled tier's review switch, and the judge-route setting exist because the harness ships no reviewed access mode. Upstream 0.1.6-alpha.1 already carries an experimental one — `AUTO_PRESET` / `registerAuto`, id `auto`, kept out of the default composition. When it reaches the default composition or the desktop payload, which `git grep -n "AUTO_PRESET\|registerAuto" upstream/master -- packages/bundle/base packages/interaction/permission-presets` and an `auto` row in the base preset table both report, all three retire in favour of it. The same condition is written into the plugin's own `cordis.patch.yml`, so it travels with the row.

## Alternatives considered

**Keep asking under 完全权限.** It is the reading that treats every mode alike. `ApprovalService` resolves an approval request under `never` to `rejected` before any answerer sees it, so the questions that mode produced were not questions: the person was shown nothing and the model was told the person had refused. Answering them in the gate's own words instead would be a refusal in the one mode whose stated meaning is that nothing is refused.

**Keep the switch defaulting to `auto`**, as 2026-09-06 decided, so an upgrade changes no behavior. Rejected on what the default costs where it applies: under a wall the operating system already refuses the file effects a review would object to, so the reviews the default buys are charged against exactly the modes a person picks to work uninterrupted. The 2026-09-06 argument for `auto` — that mounting the bundle is a deliberate act — is unchanged and no longer decisive, because the mode a session runs in is a second deliberate act the switch was ignoring.

**Keep the row named 关闭沙箱（不推荐）**, which is what the 2026-09-06 note decided and the one machine that had the feature knew it by. Rejected because the premise moved: that name was chosen while selecting the row bought approval prompts a model raises and cannot enforce, with review available under every other mode too. The switch now cannot reach this row, so review is not an option inside it — it is what the row is.

**Add a fifth preset row meaning "review on".** Still where a person would look for it, and still rejected for the reason 2026-09-06 recorded: `PermissionPresetService` resolves a preset by looking its `(sandbox, approval)` pair up in the table, so a row sharing a pair with another makes both resolve to `custom` and neither stays selectable. "Also review where a wall already stands" is a yes/no over two rows, not a row of its own.

**Read delegation from `header.parentSession`.** Shipped in 0.4.1 and withdrawn in 0.4.2: the header defines that field as the session this one was forked from, and the fork command writes it for a session a person opened and is sitting in. Forking a conversation therefore answered 这一步没有人可以答复 to every call that would have asked the person, and forking a live one overrode the access mode set in it.

**Remove the `yolo-access` row now that upstream has an `auto` of its own coming.** Rejected until that row actually reaches the default composition or the payload: `permission.defaultPreset` is stored under a closed union over this table's names and `SettingsProvider.register` rejects a stored section the schema no longer admits, so removing the id makes the whole `permission` settings section fail to install for anyone who stored it.

**Guard the decision record with the self-modification red line**, as 0.4.0 did. Withdrawn in 0.4.1: protecting it meant reading `verdictLog`, so a `Config` field decided what an unconditional refusal covered — a record written into the harness home guarded all of it and refused every call naming a session log, and `verdictLog: false` guarded nothing.

## Consequences

The access-mode control reads 仅可查看 / 工作区内修改 / 自动审查 / 完全权限, and `apps/desktop-shell/README.{md,zh.md}` says in both languages what each of the four buys. A fresh session is still pinned to the composed defaults, `workspace-write` plus `ask`, and now reviews nothing until the person asks it to.

完全权限 costs one model round trip less per call and hides nothing new: the pass-throughs are recorded as `unattended`, and in that mode the decision record is the only account of what ran.

A subagent is governed by the mode of the session that delegated it, and an unsure verdict there ends in a refusal the gate signs rather than one attributed to a person who was shown nothing. The same sentence reaches a person under a wall whose mode asks nobody.

`apps/desktop-shell/tests/builtin-permission-gateway.spec.ts` reads the preset table out of the committed tarball, so the four-row order is pinned as a literal table, the row is read as 自动审查 / 不设操作系统围墙, and the promise that no row may sell review as the sandbox's replacement is kept by pinning the three parts of the description that bound what it claims — the wall is gone, the uncertain calls are put to you, and two categories are refused outright. Each was mutation-checked against its 0.3.1 value.

`packages/client/ui-settings-general/tests/settings-root.client.spec.tsx` carries the gateway's section label only as a stand-in for a registrant's own copy; it now reads `Review settings`, so the fixture does not preserve a name the product dropped.

## Deferred

Two things wait for rc.34. The row moves onto upstream's `registerAuto` seat once that seat is in the default composition, under the retirement condition above. And the question the switch answers locally — whether a walled mode is reviewed as well — goes to upstream, because an approval knob beside `registerAuto`'s is where it belongs if upstream's reviewed mode is to cover the same ground.

## Related

[The review switch leaves the preset table](2026-09-06-gateway-review-switch.md) owns the 0.3.1 decisions this note supersedes and the ones it leaves standing. [The desktop ships the permission gateway, and the preset travels inside the plugin](2026-08-22-desktop-builtin-permission-gateway.md) owns why the plugin and its preset row are in the payload together, and why the row is offered rather than imposed.
