# Agent Note: The desktop ships the permission gateway, and the preset travels inside the plugin

Status: implemented

English | [中文](2026-08-22-desktop-builtin-permission-gateway.zh.md)

## Problem

`@haoran/dsh-llm-permission-gateway` hands every side-effecting tool call to a separately configured review model on `tools/pre-execute`, the only extension point that sees a call's arguments. It is what makes a `{sandbox: danger-full-access, approval: ask}` permission preset defensible, and it lived on exactly one machine: installed by hand with `dsh plugin --profile web add`, configured by a hand-written `~/.dsh/profiles/web/cordis.patch.yml` that also defined the `yolo-access` preset the gate is paired with.

rc.17 moved the desktop client onto a `desktop` profile of its own, for the reasons the [built-in plugins note](2026-08-21-desktop-builtin-plugins.md) records. The desktop stopped composing `web`, so it stopped composing the gateway, and the preset went with it. Nothing said so: the preset control simply no longer listed 自动审查, tool calls were no longer reviewed, and the only evidence was a feature that had been configured and was now absent.

The remedy the documentation offered was `dsh plugin --profile desktop add <tarball>` followed by copying a configuration file into the new profile — a terminal, a working pnpm, and a hand-edited YAML file, which are the three things the desktop client exists so that nobody needs. That is the same argument the sidebar and `@` mentions were shipped in the payload for, applied to a permission feature.

Two facts made this worse than a missing sidebar. A profile that keeps `yolo-access` without the gate is strictly worse than plain `danger-full-access`: full file access, no model review, and an `ask` policy whose one remaining effect is that the residual approval requests a `never` policy would have refused now reach a human with no context for them. And nothing enforced the pairing — it was a comment in the user's own patch file asking a reader not to separate two blocks.

## Decision

The plugin travels in the payload like the other three built-ins, and the preset travels inside the plugin.

**The payload.** `apps/desktop-server/package.json` declares `@haoran/dsh-llm-permission-gateway` as `file:./vendor/haoran-dsh-llm-permission-gateway-0.1.3.tgz`, with that tarball committed beside it, and `BUILTIN_WEB_BUNDLES` names it so `apps/desktop/src/profile-seed.ts` puts it in the `desktop` profile before the server starts. A `file:` tarball is what pnpm records an `integrity` hash for, and `pnpm deploy` refuses a lockfile entry without one — the same reason the screenshot plugin is vendored rather than fetched. `scripts/bundle-closure.ts` keeps the package whole on the rule it already had, that a manifest declaring `dsh.bundle` is a profile bundle nothing imports by specifier, and the staged-boot client-module check passes it over because it declares no `dsh.client`: a tool is something the agent calls, not something the page loads. `THIRD_PARTY_NOTICES.md` names it through a repository-relative link to the tarball, which the generator's override table records.

**Seeding reaches the machines that already have the problem.** `seedExistingManifest` appends missing names after whatever a manifest already lists and rewrites nothing else, so a `desktop` profile created by rc.17 gains this one name on its next launch while keeping its own `cordis.patch.yml`, its dependencies, and every field the shell does not own. Without that, the fix would reach only fresh installs, and the installs that lost the feature are exactly the ones that had it.

**The preset ships in the plugin's own patch layer.** `cordis.patch.yml` in the package contributes two rows: the gate, and the `permission` row's preset table with `yolo-access` added to it. Mounting the bundle is therefore what makes the preset exist, and removing the package removes both halves in one step. The gate cannot detect its own absence — a plugin that is not mounted runs no code — so one patch file holding both rows is the only place the coupling can hold.

An id-targeted patch replaces the target row's whole `config` rather than merging into it, so that layer restates the three presets `@deepseek-ai/dsh-base` composes, with their knob values unchanged. That restated copy is what goes stale: a base release that adds a preset, renames one, or changes a knob pair is shadowed by this file until it is updated, and the symptom is a preset control that keeps offering the old table without complaining. `apps/desktop/tests/builtin-permission-gateway.spec.ts` composes dsh-base's layer alone and then with the gateway's on top, and compares the base presets against what dsh-base itself composes rather than against a literal, so a base-side change fails there rather than shipping.

**`yolo-access` is offered, never imposed.** The patch leaves `defaultPreset` unset and declares `yolo-access` last. `PermissionPresetService` infers its default by matching the composed sandbox and approval defaults against the table in declaration order, and dsh-base derives both knobs from one `DSH_PERMISSION_MODE` expression: the pairs its composition can produce are the mode with `ask` while it is not `danger-full-access`, and `danger-full-access` with `never`. Neither is this preset's pair, so no value of that variable lands a fresh session on it. The desktop shell does not set that variable at all, so what a fresh session is pinned to is `workspace-write`.

`{danger-full-access, ask}` is also the only pair the preset could have. `{danger-full-access, never}` is already `danger-full-access`, and the service resolves a preset by looking its knob values up in the table, so two entries sharing a pair both resolve to `custom` and neither stays nameable. `ask` is the better failure mode besides: a fully open sandbox raises no escalation of its own, so the policy is silent in normal use and surfaces only where the review model says it is unsure.

**Two of the plugin's schema defaults were raised, from measurement.** `maxArgumentsChars` moves from 8000 to 200000 and `timeoutMs` from 20000 to 30000, in the plugin's `0.1.3`. Measured on 2026-08-21, the `code` preset's `run_code` calls routinely carry 9-10K characters of arguments, so the old cap held exactly the calls most worth reviewing and turned each of them into a manual approval prompt — the default defeated what the plugin is for. `deepseek-v4-flash` reviews a 200K-character call whole in roughly 5-8 seconds, which 30 seconds covers. `reasoningEffort` stays `off` and is load-bearing rather than a tuning choice: with thinking on, the 256-token output budget is spent on reasoning, the verdict JSON is truncated, and truncation fails closed, so the symptom is an approval prompt on every single call.

## Why not a preset registry

The repository's own rule is that registrations are effects, so the first thing tried was contributing `yolo-access` to `@deepseek-ai/dsh-permission-presets` through a `register()` that returns a disposer. There is no such seam. `PermissionPresetService` reads `Config.presets` once in its constructor, stores it in a private field, and derives the settings schema, the projection unit, and the `/permission` command from it there; "the preset table is process-level" is one of the limitations its own README records. Adding a registry means changing a package under `packages/`, which is a core decision with its own owner rather than something a plugin change may take on.

It remains the better shape if a second plugin ever needs to contribute a preset: an effect-registered preset would delete the restatement above and its staleness with it, and would make mounting and unmounting the plugin add and remove the entry without touching another plugin's config at all.

## Alternatives considered

**Leave it to `dsh plugin --profile desktop add`.** The supported install path, and it is the problem restated: it needs a terminal, a working pnpm, and a reachable source for the tarball. Someone who installed the desktop client to avoid a terminal cannot follow it, and the feature had already been lost once precisely because it depended on a hand-run command.

**Have the shell seed the preset into the profile's `cordis.patch.yml`.** The shell already writes that file when it creates a profile, so it could write the preset row too. Rejected twice over. The shell would own another plugin's configuration, which puts a plugin-specific table in the Electron main process and splits the pairing across two repositories again. And the seed deliberately never rewrites an existing file, so every machine that already has a `desktop` profile — which is every machine with the problem — would keep a patch file without the preset in it.

**Make `yolo-access` the default.** It is what the one machine that had this feature was using in practice, and setting `defaultPreset` would give every install the same thing without a second click. Rejected: it turns the operating-system sandbox off for every user of every desktop build, silently, on a decision none of them made. The preset belongs in the picker, where selecting it is an act.

**Restate the base presets in the desktop profile's own patch layer instead of the plugin's.** It would keep the plugin's patch file to the gate row. Rejected for the same reason as seeding the preset from the shell: the profile is user data the shell writes once, so the restatement would not reach an existing profile, and the preset would again be able to outlive the plugin.

## Consequences

Every desktop install now carries a preset that turns the operating-system sandbox off when it is selected. Selecting it makes the review model the only thing between the agent and the file system, so safety becomes a property of that model's judgment rather than of the sandbox — which is the trade the preset exists to offer, made available to people who previously could not reach it. The two red lines compiled into the plugin, credential exfiltration and edits to the permission system itself, are unaffected by any of this and cannot be configured off.

While the preset is selected, every side-effecting tool call costs one review call to `deepseek-v4-flash` on the same credentials as the session. Read-only tools are never reviewed, a verdict is one turn rather than a conversation, and a repeated call with identical arguments reuses the verdict for the rest of the agent's run.

The vendored tarball is the plugin's update channel. A new version means building it in the plugin workspace, committing the tarball, moving the `file:` specifier, and shipping a desktop build; the installer that carried a build owns the version, as it does for every other built-in.

Disabling the gate's row without also removing the preset produces the state this change exists to prevent — a preset that turns the sandbox off with nothing reviewing calls behind it. The patch layer cannot stop a user from writing that in their own layer, which is applied after every bundle layer, so `apps/desktop/README.md` states it as the one built-in whose row should not be disabled on its own and says how to take the preset out of the control along with it.
