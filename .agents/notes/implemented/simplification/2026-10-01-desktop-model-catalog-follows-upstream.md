# Agent Note: The desktop's model catalog follows upstream

Status: implemented

English | [中文](2026-10-01-desktop-model-catalog-follows-upstream.zh.md)

## Problem

From 0.1.0-rc.32 through rc.36.1 the desktop picker listed one DeepSeek model where upstream lists two. The `llm-deepseek` row of [the desktop composition layer](../feature/2026-09-06-desktop-composition-layer-content-search.md) restated a one-row `models` table — `deepseek-flash`, named `DeepSeek-V4.1-Flash` with the Chinese line `V4.1 Flash · 文本与图片` — and `models` replaces the adapter's `DEFAULT_MODELS` whole. Upstream's catalog on the 0.2.0-rc.2 base is `deepseek-flash` (`DeepSeek-V41-Flash`, text and images) and `deepseek-v4-pro` (`DeepSeek-V4-Pro`, text only). The table dropped V4 Pro on the strength of DeepSeek's announcement that V4 Pro requests would route to V4.1 Flash from 2026-09-14; DeepSeek's update log entry of 2026-09-10 withdrew that, and its pricing page still lists `deepseek-v4-pro` with its own rates. The owner decided on 2026-10-01 that the model lists follow upstream.

Two things in this fork made the difference. The composition layer's table was one. [`@haoran/dsh-default-model`](../feature/2026-08-23-desktop-builtin-default-model.md) was the other: it set the same `agent-default-model` pair dsh-base ships and a `models` table the composition layer always replaced, and the Plugins page still described it as the source of a one-model picker.

Dropping both from the payload does not reach every machine. From 0.1.0-rc.34 a save from the Models page writes the composed row's whole `config` into `$DSH_HOME/profiles/desktop-shell/cordis.patch.yml`, and the server's one-time import of a `settings.yaml` section writes through the same path, so any machine that saved a DeepSeek setting or imported such a section holds the table the bundle layer carried at the time. That layer applies after every bundle layer. Clients up to rc.33 kept settings in `settings.yaml`, which held a table where the user had touched the Models page's model list without changing it.

## Decision

**The `llm-deepseek` row of `apps/desktop-app/cordis.patch.yml` sets `retryPolicy` and nothing else**, so `resolveModels` falls back to `DEFAULT_MODELS` and both pickers list upstream's two rows under upstream's names.

**`@haoran/dsh-default-model` is withdrawn.** Its name moves from `BUILTIN_WEB_BUNDLES` into `WITHDRAWN_WEB_BUNDLES` in [`profile-seed.ts`](../../../../apps/desktop-shell/src/profile-seed.ts), which drops it from a profile an earlier build seeded and removes the shell's own flat-fallback link, while a copy installed into the profile keeps its entry. Its tarball, `file:` specifier, lockfile entries, and notices override go. New sessions start on dsh-base's own `agent-default-model`, `deepseek-official` / `deepseek-flash`, the pair the package set.

**[`model-catalog-migration.ts`](../../../../apps/desktop-shell/src/model-catalog-migration.ts) removes only the tables a release of this fork shipped.** It runs after the settings migration and before the server starts, on each launch until its record reads `done`. It takes `models` out of the profile layer's `llm-deepseek` row, and out of the `llm-deepseek` section of the `settings.yaml` the server is about to import, wherever the value equals one of three tables: the composition layer's from rc.34 to rc.36.1, its predecessor from rc.32 and rc.33, which also stated an image budget and no `toolUpdate`, and the three-row table `@haoran/dsh-default-model` 0.1.2 carried from rc.20 to rc.30. Equality is on the parsed value, key order aside and row order counting. Every other key of the row stays. A table the user changed is kept and recorded; the Models page shows it as a customized catalog with a button that restores the defaults.

**What a user stored is left as upstream leaves it.** Upstream 0.2.0-rc.2 rewrites no stored model id and aliases none: [its pi-ai catalog recovery](../../archived/bug-fix/2026-09-07-pi-ai-settings-catalog-recovery.md) rewrites no user configuration during loading, the LLM runtime states that it performs no clamping or aliasing ([`packages/llm/llm/src/index.ts`](../../../../packages/llm/llm/src/index.ts)), and [the model selection README](../../../../packages/client/ui-model-selection/README.md) keeps a saved selection that the catalog no longer lists. So the migration reads no stored model selection, reasoning effort, pi-ai route, subagent allow-list, review model, or vision-switch target, and shows no notice. A selection naming `deepseek-v4-flash` keeps working for text, since DeepSeek serves that name with V4.1 Flash, and the picker shows it as its raw id; a selection on a model pi-ai 0.87.1 dropped fails each turn until the user picks again, as it does upstream.

**`settings.yaml` waits for the settings migration to finish.** Until `settings-migration.json` reads `done`, that migration may write its migrated copy back from `settings.yaml.pre-rc34` on a later launch, so this step clears the profile, records `settingsDeferred`, and clears the file on the launch that finds the settings migration done, before that launch's server imports it. Until then it also clears the profile again on every launch: a settings migration that stopped before it moved `settings.yaml` aside, or after it wrote its migrated copy, leaves a file the server of the same launch imports into the profile row, table included.

**The record is a file of its own**, `model-catalog-migration.json` in the desktop profile, written after the files it describes. `done` makes every later launch skip the run, so a table the user builds again stays. A fault inside the run is one log line and leaves the record as the last finished write left it; the launch continues.

## What the catalog change costs a V4 Pro session

Upstream's `deepseek-v4-pro` row declares neither `systemPromptUpdate: in-history` nor `toolUpdate: addition-only`, while its `deepseek-flash` row declares both. In a V4 Pro session the loop therefore rewrites system node 0 when the system prompt changes mid-session instead of appending after the cached history, and every request declares the complete tool list, so a tool that joins mid-session changes the declarations ahead of the cached history; either misses the provider prefix cache from the first token. That is upstream's catalog as it ships, and this deployment does not restate the row to add the fields.

An image sent in a V4 Pro session goes through `@haoran/dsh-vision-switch`. When `deepseek-official` has a configured credential, the plugin moves the session to `deepseek-flash` through `session.selectModel` before sending. That call also stores Flash as the default model, so later new sessions start on Flash as well, and the session stays on Flash until the user picks Pro again. Without that credential, the plugin offers the other vision-capable models whose provider has one; when there are none, it sends the message unchanged, and the host refuses it and leaves the draft in the input box.

The shell defines no `dshDesktop` global, so upstream's page composes as it does under `dsh web`: the 0.2 preview notice (预览版说明) registers and shows once on the first empty conversation page, and the account sign-in section does not register, so this application offers no DeepSeek account sign-in.

## Alternatives considered

**Keep restating the table, with V4 Pro added and the dotted name kept.** That holds the fork's labels, and it keeps a table that has to track every catalog change upstream makes by hand, which the owner's decision rules out. It would also leave the frozen copies in profiles as they are.

**Map retired ids onto current ones.** One design mapped `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` to `deepseek-flash` on every route, fell back to the default model for dropped pi-ai ids, cleared narrowed reasoning efforts, rewrote `modelOverrides` and allow-lists, and showed a notice. Upstream does none of this to its own users, and the decision is that a fork user's state should equal an upstream user's on the same version; only what this fork itself put into profiles is undone.

**Clear every `models` value on the row.** Simpler, and it would discard tables users edited themselves. Equality with a shipped table is what tells a frozen copy from an edit.

**Record the run in `settings-migration.json`.** That marker returns early once `done`, and a run that is not finished rewrites it from a fresh object, dropping any field it does not know, so a field added there would be lost on exactly the launches that need it.

**Clear the tables in the server.** Only the shell runs before the server imports `settings.yaml`, and a server-side step needs a core change for a fork-only migration.

**Leave `@haoran/dsh-default-model` installed as a no-op.** Both of its rows were already without effect, and the Plugins page kept listing it with a description of a picker that no longer exists.

## Consequences

The picker's DeepSeek group lists DeepSeek-V41-Flash and DeepSeek-V4-Pro on fresh installs and on machines whose profile held a shipped table, and a V4 Pro request is billed at V4 Pro's own rates, which DeepSeek's pricing page sets above Flash's. The Plugins page lists thirteen built-ins.

Machines with an edited table keep it until the user restores the defaults on the Models page. A table an rc.30 or rc.33 editor wrote with any field normalized differently from the shipped value is treated as edited and kept; the exact-match rule errs toward keeping. Session logs are not rewritten, so a conversation recorded on a model pi-ai dropped needs one pick in that conversation.

`WITHDRAWN_WEB_BUNDLES` must keep `@haoran/dsh-default-model` while any installation at 0.1.0-rc.36.1 or earlier may upgrade into a later build, and the three tables must stay in `SHIPPED_MODEL_TABLES` for as long as such a machine can run this step for the first time.

[`desktop-composition-layer.spec.ts`](../../../../apps/desktop-shell/tests/desktop-composition-layer.spec.ts) checks that the composed `llm-deepseek` row carries only `retryPolicy`, that the adapter's own `Config` resolves it to the adapter's factory catalog, that sessions start on dsh-base's own default, and that the catalog lists it; adding the old table back to the row fails it. [`model-catalog-migration.spec.ts`](../../../../apps/desktop-shell/tests/model-catalog-migration.spec.ts) covers each shipped table, reordered keys, edited tables, rows it leaves unwritten, a profile whose other rows and `!!js` expression come out byte for byte, `settings.yaml` before and after the settings migration finishes, a table the server imports into the profile while that migration is unfinished, a later launch, and a run that fails; dropping the marker check, matching any `models` value, or clearing the profile on the first launch only fails it. No keyless recorded-session snapshot runs the desktop profile, so no recorded session covers the desktop catalog; upstream's Web goldens, such as `apps/web/tests/expected/onboarding-deepseek-config/default-models.expected.md`, already show the two rows it now lists.

## Related

[The desktop installer ships its own factory default model](../feature/2026-08-23-desktop-builtin-default-model.md) records why the withdrawn package was added and what it did through rc.36.1. [The desktop composition layer](../feature/2026-09-06-desktop-composition-layer-content-search.md) owns the `llm-deepseek` row's retry policy. [Withdrawing the vendored right sidebar](2026-09-14-desktop-withdraw-better-sidebar.md) is the precedent for `WITHDRAWN_WEB_BUNDLES`.
