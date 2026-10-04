# Agent Note: The desktop manages plugins through upstream's plugin manager

Status: implemented

English | [中文](2026-09-26-desktop-plugin-management-on-upstream.zh.md)

## Problem

Up to 0.1.0-rc.33 the desktop had two plugin installers composed side by side. `@haoran/dsh-plugin-updates` drew an Updates tab over the shell's loopback plugin-admin service, which ran the shipped pnpm under the bundled Node. It updated only packages a profile had already installed, one at a time, behind a native confirmation. Upstream's `plugin-manager` Host row and `ui-plugin-manager` sidebar page install, enable, disable, and remove any bundle, check plugin compatibility before and after an install, and take a file lock on the profile. The desktop layer kept upstream's pair off, so every fix upstream shipped in its plugin manager bypassed the desktop, and the fork kept maintaining an installer of its own.

Turning upstream's pair on raises three problems of its own. `pnpmCommand` names one executable and passes it no arguments before the pnpm subcommand. The shipped `resources/runtime/pnpm/bin/pnpm.mjs` starts with `#!/usr/bin/env node`, and a customer machine has no Node on `PATH`. The plugin page can install `@deepseek-ai/dsh-experimental-auto-review` from a registry, although the payload withholds it; its layer mounts upstream's Auto beside `@haoran/dsh-llm-permission-gateway`, both read the same knob pair, and one call would be reviewed twice. The web app's cordis preset mounts the `plugin_manager` agent tool as soon as the `pluginManager` service exists; one call can install Host code or disable the gateway's own row, and under 自动审查 the review model would decide that call.

## Decision

**Upstream's plugin manager is the desktop's only installer.** `apps/desktop-app/cordis.patch.yml` leaves `plugin-manager` and `ui-plugin-manager` on. Its `plugin-manager` row carries `config` alone, so dsh-base's profile-gated `disabled` expression still applies.

**pnpm runs through a launcher script beside the bundled Node.** The payload carries `resources/runtime/dsh-pnpm`, a POSIX sh script, on macOS and `resources/runtime/dsh-pnpm.cmd` on Windows. Each runs `pnpm/bin/pnpm.mjs` under the Node in the same directory, passes every argument through, and puts that directory first on `PATH` for everything pnpm starts. `apps/desktop-shell/src/pnpm-launcher.ts` holds both scripts. `scripts/package.ts` stages both on every run, and `verifyStaging` requires both, with the macOS one executable. `scripts/after-pack.cjs` copies the target platform's script into `runtime/`. A packaged launch gives the server child `DSH_DESKTOP_PNPM=<script path>`; the `plugin-manager` row reads it as `pnpmCommand: !!js process.env.DSH_DESKTOP_PNPM ?? 'pnpm'`. A development launch sets nothing and uses `pnpm` on `PATH`.

**`@haoran/dsh-plugin-updates` and the plugin-admin service leave the payload.** The plugin is in `WITHDRAWN_WEB_BUNDLES`, so the first launch of this build drops its name from a profile an rc.33 build seeded and removes the flat-fallback link. The loopback service, its native confirmation, its environment variables, and the exports that served only its repair routes are deleted. [The plugin admin service note](../../archived/feature/2026-08-25-desktop-plugin-admin-service.md) is archived.

**The `defective` and `removed` lists in `web-migration.json` are still written, and only the launch log shows them.** Every path that records a name writes one line to `dsh-server.log`. That line is `disabled migrated <name>: …`, `removed <name>: …`, or `disabled migrated <name> after it failed to load`. No screen lists either list. Deleting a name's entry from the marker lets the next launch admit it again, which `tests/profile-seed.spec.ts` covers.

**Through 0.1.0-rc.37, every launch kept upstream's auto-review off in the profile layer; [the placeholder note](2026-10-04-desktop-withheld-bundle-placeholders.md) supersedes this row.** `seedAutoReviewGuard` in `src/profile-seed.ts` kept `- id: auto-review` / `disabled: true`, under a comment naming its purpose, in `$DSH_HOME/profiles/desktop-shell/cordis.patch.yml`. The profile layer applies after every bundle layer, including one the plugin page adds later, so an installed auto-review composes off. The row is recognized as `SEEDED_PERMISSION_ROWS` are. An entry that is exactly this row is left alone. Any other entry declaring the id is left alone too, with a log line; the plugin page's enable, for example, writes `disabled: false` onto this row. Otherwise the row replaces the `[]` of the template or of an emptied layer, or follows the last block entry. A layer written as a non-empty flow sequence is logged and left alone. The web-profile sync treats the template carrying this row as unedited, so its one-time copy of the web patch layer still happens.

**The gateway sends every `plugin_manager` call to a person.** The desktop layer's `llm-permission-gateway` row sets `alwaysAsk` with `plugin_manager` and a sentence naming what the call can change. The field replaces the gate's default map, so the row restates `browser_auth` verbatim from the 0.5.0 `DEFAULT_ALWAYS_ASK`. Under 自动审查 and the walled modes the gate asks the person before any review model sees the call. Under 完全权限 the gate steps aside, and the tool's own rule lets a `danger-full-access` session call it unasked.

## Alternatives considered

**Keep `@haoran/dsh-plugin-updates` and leave upstream's pair off.** This was the default 0.1.0-rc.34 plan. The fork would have maintained a second installer and switched it to upstream's compatibility check. Rejected: it updates only the fork's own plugins, and every later improvement to upstream's manager would miss the desktop.

**Run both installers.** Rejected: the shell's in-process update lock and upstream's profile file lock do not see each other, so both could write `package.json` and `pnpm-lock.yaml` at once. The plugin page would also expose auto-review regardless.

**Point `pnpmCommand` at the bundled Node or at `pnpm.mjs`.** Rejected: the field takes one executable and no prefix arguments, so Node cannot receive the script path. `pnpm.mjs` itself resolves `node` through `PATH`, where the machine has none. Upstream's own Electron application passes a package-manager invocation through `ProfileContext.packageManager`, which only its host launcher sets. This shell launches the public `bin.js` and must not add an argv escape for it.

**Put the auto-review row in the desktop-app bundle layer.** Rejected: the plugin page appends a newly installed bundle after `@deepseek-ai/dsh-desktop-app`, so an id-targeted row there would run before auto-review's `insert` and match nothing. The profile layer is the first layer that applies after every bundle.

**Rewrite the auto-review row to `disabled: true` on every launch, whatever it says.** Rejected: the plugin page's enable writes onto that same row, and a person who turned Auto on would find it off again after every restart with no explanation.

**Disable the cordis preset's `tool-plugin-manager` row instead of asking.** Rejected: that row sits inside `preset-cordis`'s `config.plugins`, which no id-targeted patch reaches. Asking also keeps the tool usable when a person wants it.

**Turn `preset-cordis` off whole.** One id-targeted `disabled: true` row reaches it and takes `plugin_manager` away with it. Rejected: it also takes the cordis preset away, and that preset stays available on the desktop.

**Have the gateway step aside when upstream's Auto is mounted (Q-G5).** Not taken: the desktop keeps Auto from mounting, so the gateway carries no such check. Through 0.1.0-rc.37 the seeded `auto-review` off row in the profile layer was the only thing that kept the two reviewers apart, and a person who changed it to `disabled: false`, which is what the Plugins page's enable writes, mounted Auto beside the gateway, where every call was then reviewed twice with no message saying so. From 0.1.0-rc.38 the payload's placeholder keeps Auto from loading at all ([the placeholder note](2026-10-04-desktop-withheld-bundle-placeholders.md)).

## Consequences

The desktop gains upstream's install, enable, disable, and remove actions, its compatibility refusals, and whatever its plugin manager gains later. It loses the Updates tab: upstream's page has no per-package "update to newest" action and no one-step rollback, and no native modal confirms an install. `$DSH_HOME/dsh-plugin-updates/last-update.json` stays on a machine that used the old tab, and nothing reads it.

A migrated plugin that is disabled or tombstoned is visible only in `dsh-server.log`.

Through 0.1.0-rc.37, `--dump-config` on a profile without auto-review installed wrote `patch: entry "auto-review" not found` to stderr, and `web` writes nothing for it. Neither line carries a `LOAD_FAILURE_MARKERS` fragment or matches `quarantineLoadFailureFromOutput`, probed on a `mkdtemp` home.

`alwaysAsk` reaches a machine only while the gateway's composed `config` carries this layer's map. A gateway save from the settings page, `/review`, or the one-time `settings.yaml` import writes the whole composed row into the profile layer, so a save made on this build keeps `plugin_manager`. `settings-migration.ts` gives the same map to the id-targeted row it rewrites from a kept `insert`, and to any id-targeted gateway row whose `config` has no `alwaysAsk`. A profile-layer row whose `config` sets its own `alwaysAsk` replaces the map.

The Plugins page disables a bundle by taking its name out of `dsh.profile.bundles`. For a built-in that lasts until the next launch: the seeding inserts the name again, before `@deepseek-ai/dsh-desktop-app` so that layer's rows still find the rows the plugin inserts. Turning a built-in off for good takes a `disabled: true` row in the profile layer.

No real Windows install has run the Windows launcher yet. Execa 10 runs a `.cmd` as `cmd.exe /d /s /c` with every argument escaped for the batch file's `%*`, and `killDescendants` has to reach `node.exe` through that `cmd.exe` when a run is cancelled or goes silent. Both need a real Windows machine to confirm.

## Related

[The desktop payload on the 0.1.7-rc.2 base](../process/2026-09-26-desktop-payload-on-the-rc2-base.md) owns withholding packages and the boot gate; [the placeholder note](2026-10-04-desktop-withheld-bundle-placeholders.md) owns the placeholders that replace auto-review and the inspector bundle, and supersedes the auto-review guard row; [the web profile migration](2026-08-25-desktop-web-profile-migration.md) owns the `defective` and `removed` lists; [retiring seeded permission rows](../bug-fix/2026-09-17-retire-seeded-permission-patch-rows.md) owns the row recognizer the guard reuses.
