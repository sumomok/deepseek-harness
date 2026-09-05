# Agent Note: The review switch leaves the preset table

Status: implemented

English | [中文](2026-09-06-gateway-review-switch.zh.md)

## Problem

`@haoran/dsh-llm-permission-gateway` 0.1.5 tied model review to one permission preset. The row it shipped was named 自动审查, and selecting it did two things at once: it turned the operating-system sandbox off, and it was the only state in which the review model's judgment mattered. Three things were wrong with that pairing on a desktop.

Review and the sandbox are not alternatives. Under `workspace-write` the sandbox already confines `bash`, `pwsh`, `write`, `edit`, `str_replace_editor`, `terminal_open`, and `terminal_send`, and it reaches none of `run_code`'s program body — which runs on a worker thread inside the harness process with `node:fs`, `node:child_process`, and `fetch` in reach — nor any capability tool such as `web_fetch` or `screenshot`. The calls with no wall were exactly the ones nothing reviewed, because reviewing them required giving up the walls on everything else.

The row's own wording promised what it could not deliver. A review model can return `allow` or `ask`; it cannot enforce a refusal, and 0.2.0 made that structural by downgrading every `deny` verdict to a question. A preset named "automatic review" therefore read as a mode where the model checks each step, when what it actually bought was approval prompts a model raises with the sandbox switched off behind them.

And the preset table is the wrong place for a switch. `PermissionPresetService` resolves a preset by looking its `(sandbox, approval)` pair up in the table, so a second row sharing a pair makes both resolve to `custom` and neither stays selectable; the one free pairing, `approval: never`, removes the channel the gate's own `alwaysAsk` entries need. There was no room for a fifth row that meant "review on".

## Decision

The desktop moves to `@haoran/dsh-llm-permission-gateway` 0.3.1 (sha256 `9846923006f8dff42c2f0177de7ab78bbb359d275c4a326875a4f8ce33da3091`), replacing the 0.1.5 tarball.

**Review is the plugin's own setting, in force under every preset.** `auto` out of the box. The **Automatic review** settings section (自动审查) is the switch, `/review auto` and `/review manual` are the same one from the composer, and the choice is stored in the plugin's own `llm-permission-gateway` settings namespace. `manual` keeps the two red lines and the `alwaysAsk` entries and skips everything else.

**Under a sandbox the gate reviews only what the sandbox does not confine.** Which calls those are is read per call from the running installation through `ctx.sandboxPolicy.resolve({ session })` and the mounted shell executor's reported `sandboxMode`; the `walledTools` list is passed through while both report a wall, and reviewed again wherever they do not. Replaying one recorded 97-call session under the new rules, 81 model reviews become 52 under `workspace-write` and 80 under `danger-full-access`.

**The gate answers the sandbox's own escalation prompts.** Where a confined `bash`, `pwsh`, `write`, or `edit` call is refused for reaching outside its walls and the agent asks for that refusal to be lifted, the same model reviews the request against the refused call the gate remembered, grants `allowed-once` on `allow`, and delegates to the person on `ask`, on a failure under `onFailure: ask`, when the call was not remembered, and when the request names a different tool than the note holds.

**The gate never refuses on the model's word.** A `deny` verdict becomes an `ask`, recorded with `downgraded: true`, and every ask this gate produces is put down the rest of the `tools/pre-execute` waterfall first: a `deny` or a more specific `ask` further along is returned as it stands, and only where the chain allows does this gate's own question stand.

**The reasons are Simplified Chinese.** `reasonLanguage` defaults to `简体中文`, and every sentence the plugin writes itself — a red line, an oversized call, a review that produced no verdict, the `/review` echo, the `browser_auth` cost sentence — is compiled Chinese regardless of that setting.

**The settings section also picks which model reviews**, over the providers whose model catalog this installation could read. `config.provider` and `config.model` stay required and become the fallback: what a fresh installation reviews on, and what is used where a stored provider has no adapter. A change takes effect on the next call and empties both verdict caches.

**The preset row keeps its id and changes its name.** `yolo-access` is now 关闭沙箱（不推荐）, described as what it is: the OS walls are gone, review still runs, and review can only raise a prompt. The access-mode control therefore reads 仅可查看 / 工作区内修改 / 完全权限 / 关闭沙箱（不推荐）.

**The gateway gains a browser half.** 0.3.1 declares `dsh.client`, so eleven of the twelve built-ins now have one and the packaging boot gate requires this plugin's `client.js` among the client modules the served index names.

### Upgrade compatibility on an existing installation

The preset **id** is unchanged, which is what an installed machine depends on. `permission.defaultPreset` is stored in the settings document under a schema that is a closed union over the preset table's names, and `SettingsProvider.register` rejects a stored section the schema no longer admits instead of falling back — the `permission` section would then fail to install, the stored default would be dropped, and the settings page would lose its permission section altogether. Renaming the row's `name` and `description` moves none of that.

Nothing the shell writes names a preset or a gateway config key. `apps/desktop/src/profile-seed.ts` writes the profile manifest, the empty user patch template, and the pnpm settings, and never revisits an existing file; the gateway's own `cordis.patch.yml` is the only layer that sets its config.

The `Config` keys are a superset of 0.1.5's: `mode`, `walledTools`, and `reasoningBudgetTokens` are added and none is removed, so a hand-written profile layer that restated the old keys still loads. Two defaults move — `reasonLanguage` from `English` to `简体中文`, and `readOnlyTools` gains `show_chart`, `job_output`, `content_show`, and `web_search` — and a layer that restated either keeps what it wrote, because an id-targeted patch replaces the whole `config` block.

The `llm-permission-gateway` settings namespace is new, so no machine holds a stored section for it to reject.

## Alternatives considered

**Keep the row named 自动审查.** It is the name the one machine that had this feature knew it by. It names a mode that no longer exists: review now runs under every preset, so the row would promise a check that selecting it does not buy, while hiding the one thing selecting it does — turning the sandbox off.

**Remove the `yolo-access` row now that it only means "sandbox off".** `danger-full-access` already exists and the pair `{danger-full-access, ask}` is the only thing this row adds. Rejected because removing it breaks the settings page for anyone whose stored `defaultPreset` names it, in the way the compatibility section above describes; the row costs a table entry and repairs an installed machine.

**Default `mode` to `manual`, so an upgrade changes nothing until someone asks for it.** Mounting this bundle is already a deliberate act, and `manual` would make the upgrade a no-op on every machine. Under `auto` the gate now reviews strictly less than 0.1.5 did — the sandbox keeps everything it already covered — so the default costs only the reviews the sandbox cannot make.

**Add a fifth preset row meaning "review on".** It is where a user would look for it. The permission service resolves a preset by its `(sandbox, approval)` pair, so a row sharing a pair with another makes both resolve to `custom` and neither stays selectable, and the one free pairing — `approval: never` — removes the approval channel this gate's `alwaysAsk` entries and its own asks need.

**Leave the escalation prompts to the person.** It is the answer that adds no authority. It also means the agent's ordinary out-of-workspace read ends in a prompt the person has no context for, in a product whose users are not reading argv; and the model answering it can only widen one call, once, with the refused call's own arguments in front of it.

## Consequences

Selecting an access mode and turning review on are now two independent choices, and the desktop README says so in both languages. A person who wants the walls and the review — the state the old table could not express — has it out of the box.

Review costs less under a sandbox and the same where none is composed. The measured saving is the walled tools plus the nested sub-calls a `run_code` wrapper dispatches, which used to be reviewed twice.

The escalation answerer is the one place this plugin grants rather than asks. On the desktop an approval answerer is always composed, so the person is still reachable whenever the model is unsure; `/review manual` turns the answerer off with the rest.

`apps/desktop/tests/builtin-permission-gateway.spec.ts` reads the preset table out of the committed tarball, so the rename is pinned there rather than described: it asserts the row's name, that its description says the OS walls are gone, and that the description does not offer review as what replaces them.

## Related

[The desktop ships the permission gateway, and the preset travels inside the plugin](2026-08-22-desktop-builtin-permission-gateway.md) owns why the plugin and its preset row are in the payload together, and why the row is offered rather than imposed.
