# Agent Note: The desktop payload carries placeholders for the bundles it withholds

Status: implemented

English | [中文](2026-10-04-desktop-withheld-bundle-placeholders.zh.md)

## Problem

`@deepseek-ai/dsh` lists `@deepseek-ai/dsh-experimental-auto-review` and, from 0.2.1-alpha.1 on, `@deepseek-ai/dsh-experimental-inspector-profile` as runtime dependencies so that upstream's Plugins page can offer them. Upstream's Auto reads the same knob pair as `@haoran/dsh-llm-permission-gateway`, so mounted beside it every call would be reviewed twice. The inspector bundle mounts developer inspectors the desktop does not offer.

Builds 0.1.0-rc.34 through rc.37 withheld auto-review from the payload and wrote an `auto-review` / `disabled: true` row into the profile's own patch layer on every launch ([the plugin management note](2026-09-26-desktop-plugin-management-on-upstream.md)). Withholding the package did not stop an install: the plugin manager resolves a bundle from the installation first and the profile second, so with the installation copy gone, a copy the `plugin_manager` tool or `dsh plugin add` put into the profile resolved and loaded. The row kept that copy composed off, but only while nobody edited it, and the Plugins page's enable wrote `disabled: false` onto it. With no such copy installed, which is every machine, the row targeted no entry, and `--dump-config` printed `patch: entry "auto-review" not found` on every run. The inspector bundle had no guard at all; it was listed as an official bundle and could be switched on.

## Decision

**The payload carries a placeholder for each withheld bundle.** `PLACEHOLDER_BUNDLES` in `apps/desktop-shell/src/profile-seed.ts` names auto-review and inspector-profile. `scripts/package.ts` removes them from the staged tree with the other `WITHHELD_PACKAGES` and writes `server/node_modules/<name>/package.json` holding only the name and version `0.0.0-withheld` (`placeholderManifest` in `scripts/staged-boot-gate.ts`). The manifest has no `dsh` field, entry point, or dependency. Installation-first resolution then finds the placeholder for every lookup: `listBundles` skips an unselected package without `dsh.bundle`, `setBundleEnabled(name, true)` fails with `not-bundle`, an installation through the `plugin_manager` tool or the Remote API is rolled back with the same code, and `dsh plugin add` installs it as a plain dependency and selects nothing. A profile copy is never resolved.

**The two plugins only the inspector bundle depends on are withheld without a placeholder.** `@deepseek-ai/dsh-experimental-inspector` and `@deepseek-ai/dsh-experimental-session-inspector` are plugin packages, not bundles, and with their bundle withheld nothing in the closure loads them.

**The packaging gates hold the placeholders to their exact bytes.** `findWithheldDirectories` passes over a directory only when it is `node_modules/<name>` at the tree root, holds nothing but `package.json`, and those bytes are the placeholder's; a nested copy, an extra file, or other bytes are still reported. `verifyStaging`, `--skip-deploy` included, requires every placeholder to be present that way. The staged boot calls `pluginManager/listBundles` and `pluginManager/setBundleEnabled` over the browser's RPC route: the list must hold bundles and none of the withheld packages, each placeholder must be refused as `not-bundle` without a change, and neither the boot's output nor the `--dump-config` stderr may print the `auto-review` not-found line.

**The shell retires the guard row and drops placeholder selections on every launch.** Before the `web` profile sync, `retireAutoReviewGuard` removes the exact text the earlier builds wrote, comment block included, wherever no further line of the same entry follows it, with one blank line above it, and puts `[]` in its place when no entry is left, so the guarded template becomes the empty template. Any other `auto-review` row, the text with a key added under it included, is left alone and logged. After the sync, `deselectPlaceholderBundles` removes both names from `dsh.profile.bundles`, and `migrationRefusal` keeps the `web` sync from admitting them.

## Alternatives considered

**Keep the guard row and accept the warning.** Rejected: the row left the profile-copy route open, a person's edit or the Plugins page's enable reopened it with no message, and the inspector bundle would have needed a second row with the same gaps.

**Keep the real packages and turn their rows off in the desktop-app layer.** Rejected: the Plugins page appends a newly selected bundle after `@deepseek-ai/dsh-desktop-app`, so that layer's id-targeted rows apply before the bundle's `insert` and match nothing; the bundles also stay listed and selectable.

**Ship the placeholder as a workspace package that `apps/desktop-server` depends on.** Rejected: the workspace already holds the real package under each name, and `@deepseek-ai/dsh` depends on it as `workspace:*`, so a second package of the same name cannot join the workspace. Writing the placeholder after the deploy also keeps its bytes owned by one function the gates compare against.

**Have the gateway step aside when upstream's Auto is mounted.** Not taken: Auto can no longer be mounted on the desktop, so the gateway needs no such check.

## Consequences

Upstream's Auto and the inspectors cannot be installed on the desktop, rather than installed and kept off. Setting the old row to `disabled: false` no longer turns Auto on, and nothing on screen says so. An `auto-review` row a person edited stays in the profile, targets no entry, and logs one line per launch.

The placeholder exempts nothing else: a real copy anywhere in the staged tree still fails `verifyStaging`. A copy an earlier build's user installed into the profile's `node_modules` stays on disk, hidden from the Plugins page once deselected, and is never loaded.

A later upstream bundle the desktop does not run needs the same decision, and adding its name to `PLACEHOLDER_BUNDLES` covers the payload, the gates, and the profile.

## Related

[The plugin management note](2026-09-26-desktop-plugin-management-on-upstream.md) owns upstream's plugin manager on the desktop; this note supersedes its auto-review guard row. [The desktop payload on the 0.1.7-rc.2 base](../process/2026-09-26-desktop-payload-on-the-rc2-base.md) owns withholding packages at staging and the boot gate.
