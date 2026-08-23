# Agent Note: The desktop installer ships its own factory default model

Status: implemented

English | [中文](2026-08-23-desktop-builtin-default-model.zh.md)

## Problem

A fresh desktop install opens its first session on `deepseek-v4-flash`, because that is the `agent-default-model` composition entry `@deepseek-ai/dsh-base` carries, and `@deepseek-ai/dsh-base` is the base layer of every profile the harness composes. The model picker beside it lists the three advisory rows of `@deepseek-ai/dsh-llm-deepseek`'s factory catalog, where the one model with vision is labelled `DeepSeek-V4-Flash-Vision-Exp`. Both facts are deployment choices wearing the clothes of upstream defaults: the desktop client wants a vision model on first launch and a picker row that reads as the default, and neither belongs in a package every CLI install composes.

`@haoran/dsh-default-model` was written to answer exactly that, and its README describes the delivery it expects: vendored into the embedded server closure, seeded into the web profile's `dsh.profile.bundles` on first launch. This repository carried no version of it. The desktop payload had four built-in plugins, this was not among them, and the deployment default the package exists to set was applied on no machine.

## Decision

Vendor `@haoran/dsh-default-model` 0.1.1 beside the other two `@haoran/` tarballs under `apps/desktop-server/vendor/`, and name it in `BUILTIN_WEB_BUNDLES` so `apps/desktop/src/profile-seed.ts` puts it in the `desktop` profile before the embedded server reads that profile. It is the fifth built-in and the last bundle layer, which is what lets it settle entries the four before it leave alone.

**The package is a patch layer and nothing else.** It has no `src/`, no `lib/`, and no entry point; its whole substance is `cordis.patch.yml`. That works because the harness never imports a bundle: `loadProfile` reads the bundle package's manifest, takes the path in `dsh.bundle.patch`, and parses that YAML. The same declaration is what keeps it in the payload — `scripts/bundle-closure.ts` deletes every third-party package nothing reachable imports, and treats a manifest declaring `dsh.bundle` as a profile bundle kept whole. It declares no `dsh.client`, so the packaging build's client-module check passes over it: a default model is composition, not something the page loads.

**Two id-targeted overrides, both complete values.** `agent-default-model` becomes `{provider: deepseek-official, model: deepseek-v4-flash-vision-exp}`, so an Agent created without a session-local selection starts on the vision model. `llm-deepseek` gets a `models` catalog that restates the two untouched factory rows verbatim and relabels the third `default · DeepSeek-V4-Flash-Vision`. The label leads with `default` because the picker trigger spells a selection `<model> · <effort>` and the same popup carries a reasoning-effort level named `Default`; a row labelled only `default` reads as that level. The row's `id` is unchanged, so the relabel never reaches the wire.

**Both blocks are written as whole config values because the patch mechanism gives no choice.** `applyEntryPatches` (`vendor/include/src/index.ts`) matches a patch to an entry by `id` and then assigns each of the patch's top-level keys onto it — `target[key] = value` — so `config` replaces the entry's config outright and any key the earlier layer set and this one omits falls back to the plugin's schema default. It costs nothing at this layer: `dsh-base` gives `llm-deepseek` no config at all, and gives `agent-default-model` the same two keys this package sets. It is the rule any later layer inherits, including a user's own `cordis.patch.yml`.

**The seed is name-keyed, so this needs no version-specific handling.** `seedBuiltinBundles` appends any missing name to an existing profile's `dsh.profile.bundles` and links the package into `$DSH_HOME/profiles/node_modules`, both additively and idempotently; the patch layer itself is read from the shipped copy on every launch. A machine already running a desktop build gets the name appended after the four it already lists, which is the position this layer needs.

## What an existing installation sees

A user who has already picked a model keeps that choice. `$DSH_HOME/settings.yaml` is a settings document read live, and its `agent-default-model:` section — exactly what the web UI writes when someone picks a model ([the default model follows the picker](2026-08-07-default-model-follows-the-picker.md)) — sits above every bundle patch layer. This package sets what you get before you have chosen, never over what you chose.

What does change for such a user is the picker row: the vision model is listed as `default · DeepSeek-V4-Flash-Vision` whatever their stored selection is, because the catalog is a composition entry rather than a per-user one. Their own `cordis.patch.yml` is untouched, since the seed never edits the user patch layer.

## Alternatives considered

**Move the defaults into `@deepseek-ai/dsh-base` or `PROFILE_TEMPLATES`.** One edit, no new package, and it would cover a fresh profile. Rejected because both are published surface every CLI install composes: `dsh-base` is the base layer of every profile, and a template is the harness's own answer for a profile it creates. A deployment's preferred model is not the harness's default, and the vision model's picker label is a product decision for one client.

**Leave it to a per-user profile patch.** `$DSH_HOME/profiles/desktop/cordis.patch.yml` sets both entries for a machine, and it is where a machine-local override belongs. Rejected as the delivery mechanism because a profile is user data: `initProfile` writes it once and the seed deliberately never revisits it, so the file exists on every current install already and would have to be edited on each one by hand. It stays the right place for someone who wants a different default, and remains above this layer.

**Relabel the row upstream in `@deepseek-ai/dsh-llm-deepseek`.** The catalog is that adapter's, and renaming `DeepSeek-V4-Flash-Vision-Exp` there would need no restated table. Rejected for the same reason as `dsh-base`: the label reads `default` only because this deployment makes it the default, and it would be false in any install that does not.

## Consequences

A fresh desktop install opens its first session on `deepseek-v4-flash-vision-exp`, so image input works without anyone choosing a model, and the picker names that row as the default it is. The version is the installer's, like every other built-in: changing it means shipping a desktop build.

The restated `models` table is a whole-table replacement — `resolveModels` reads `config.models ?? DEFAULT_MODELS` and never merges the two — so a model added to `@deepseek-ai/dsh-llm-deepseek` upstream does not reach the picker until it is added to this table as well. The plugin's own `tests/patch.spec.ts` is what holds the two together: it reads the installed adapter's catalog out of its `Config` schema and compares it row by row, and reads `@deepseek-ai/dsh-base`'s `cordis.patch.yml` to assert both patched ids still exist there. Those checks live in the plugin's repository and run at the versions its devDependencies pin, so a change to this repository's catalog is caught when the plugin is next built, not by any gate here.

Three fields are deliberately absent from the vision row — `contextWindow`, `imagePixelBudget`, and `imageMaxBytes` — because each falls back to the adapter value the factory row itself carries. Inheriting keeps this table from pinning numbers upstream may move; the drift test compares every inherited value against the installed adapter.

An id-targeted patch whose target id is gone applies to nothing: `applyEntryPatches` writes `patch: entry <id> not found` to the loader log and continues. That line reaches the server log rather than any user, so a rename of `agent-default-model` or `llm-deepseek` in `dsh-base` would silently restore the factory default here. Both ids exist in this repository's `dsh-base` today, and the plugin's assertion on them is the check that fails when one moves.

This is the first built-in whose whole effect is on composition rather than on a tool or a page, so the packaging build proves less about it than about the others. `verifyStagedBoot` requires every name in `BUILTIN_WEB_BUNDLES` to be seeded and the payload to boot, which covers the package travelling and resolving; `verifyClientModules` skips it for want of a `dsh.client`. That the two overrides land as intended is `dsh --profile desktop --dump-config`, not a gate.
