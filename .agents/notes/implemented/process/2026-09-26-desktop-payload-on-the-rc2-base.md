# Agent Note: Desktop payload and boot gate on the 0.1.7-rc.2 base

Status: implemented

English | [中文](2026-09-26-desktop-payload-on-the-rc2-base.zh.md)

## Problem

On dsh 0.1.7-rc.2 the desktop server closure grows past what the desktop profile runs, and a staged boot that reaches its URL line no longer shows that the profile composed.

`@deepseek-ai/dsh` lists `@deepseek-ai/dsh-experimental-auto-review` as a runtime dependency so upstream's plugin page can offer it. Its review runs beside this deployment's permission gateway rather than in place of it. The same closure brings in `@deepseek-ai/libreoffice-kit` through `dsh-office-to-pdf` and `dsh-skill-office`, with the build host's LibreOffice engine package, and `stageWindowsVariants` fetched the win32-x64 engine beside it. Each engine is a whole LibreOffice build of well over a hundred megabytes, and the web app's `office-to-pdf` row starts converters on it for the right Sidebar's document tab.

The shipped bundles compose upstream's plugin manager: dsh-base's `plugin-manager` Host row serves the `pluginManager` service that installs, enables, and removes bundles, and dsh-web-app's `ui-plugin-manager` row is its sidebar page. That installer can install a package the payload leaves out.

The base skips a `dsh.profile.bundles` name it cannot resolve or admit, writes one `skipping profile bundle` line to stderr, and starts without that bundle's layer. A refused plugin row is disabled with a `disabling profile plugin` line, and an entry that does not activate is reported in one `did not activate` warning. The packaging boot gate treated the URL line as proof that every seeded bundle composed.

## Decision

**The payload withholds upstream's auto-review.** `WITHHELD_PACKAGES` in `apps/desktop-shell/scripts/staged-boot-gate.ts` names it, and `package.ts` removes it from the staged tree's top-level `node_modules` after `stageWindowsVariants` and before the payload inventory, so the payload gate never sees it as a removal. `verifyStaging` then fails when a directory of that name remains at any depth, because a hoisting change can nest a copy under another package, where the top-level removal misses it. From 0.1.0-rc.38 the list also names the inspector bundle and its two plugins, and the two bundles get a placeholder whose exact top-level directory the check passes over ([the placeholder note](../feature/2026-10-04-desktop-withheld-bundle-placeholders.md)).

**No payload carries a LibreOffice engine, and the Office preview is off.** `platformDirRules` in `apps/desktop-shell/scripts/platform-dir-rules.ts` drops every `@deepseek-ai/libreoffice-kit-<suffix>` directory from both targets and keeps the kit's entry package, which `dsh-office-to-pdf` imports statically; the kit resolves an engine only when a converter is created. `stageWindowsVariants` does not fetch the win32-x64 engine and prints that it skipped it. `EXEMPTIONS['platform-variant']` in `payload-gate.ts` takes the engine directories native to a target, which that target's payload now lacks. That exemption names a directory, not a direction, so it would equally pass an engine riding into the other target's payload; `deriveServerPayload` therefore fails any finished payload holding a directory named for an engine the staged kit's `optionalDependencies` declare, at any depth. The desktop-app layer disables `office-to-pdf`, so nothing creates a converter.

**Plugin management is upstream's; [the plugin management note](../feature/2026-09-26-desktop-plugin-management-on-upstream.md) owns that decision.** The desktop-app layer leaves `plugin-manager` and `ui-plugin-manager` on and points `pnpmCommand` at the shipped pnpm launcher, and the payload's placeholder keeps a registry copy of auto-review from loading ([the placeholder note](../feature/2026-10-04-desktop-withheld-bundle-placeholders.md)). The layer adds no `tool-plugin-manager` row. The agent tool the cordis preset enables sits in `preset-cordis`'s `config.plugins`, which no id-targeted patch reaches; an `id: tool-plugin-manager` row would patch only dsh-base's top-level row, which dsh-base and dsh-web-app already disable. The gateway row's `alwaysAsk` sends each call of that tool to a person instead.

**The staged boot fails on a load report, and a composed dump must show the desktop layer.** `verifyStagedBoot` collects the server's stderr and fails the package on any line carrying one of `LOAD_FAILURE_MARKERS`: `skipping profile bundle`, `disabling profile plugin`, or `did not activate`. It then runs `--dump-config` against the same build home and requires `verifyDesktopLayer` to find `session-query-sqlite` composed with `openAt: first-search`, the value only the last bundle, `@deepseek-ai/dsh-desktop-app`, sets.

**The staged boot runs without the build's package-manager environment, and the staged tree must hold the installation's closure.** pnpm's `.bin` shims export `NODE_PATH` naming the workspace's `node_modules/.pnpm/node_modules`, and `resolveBundleDir` searches it, so the staged boot found `@deepseek-ai/dsh-base` in the build checkout while the payload had none: pnpm's legacy deployer leaves `@deepseek-ai/dsh` beside the deploy source with dsh-base only in its nested `node_modules`, which `restoreLegacyHoists` dropped. Without `NODE_PATH`, an installed server skipped dsh-base and failed to start. `stagedBootEnv` in `staged-boot-gate.ts` removes `NODE_PATH`, `npm_*` and `PNPM_*` from the staged boot and `--dump-config`; `missingProductionDependencies` fails a staged tree lacking any production dependency or required peer of `@deepseek-ai/dsh`, and a finished payload lacking its `@deepseek-ai` part; `restoreHoistedDependencies` in `legacy-hoists.ts` copies the production dependencies a restored hoist carries only inside itself. The deploy installs no peers, so `@deepseek-ai/dsh-ptc-runtime`, `dsh-hook-protocol`, `dsh-sdk-protocol` and `dsh-client-store`, which the closure names only as required peers, are listed in `apps/desktop-server/package.json`; without `dsh-ptc-runtime` the base layer's `ptc-runtime` row fails to import.

## Alternatives considered

**Ship the LibreOffice engines and turn Office preview on.** Rejected for 0.1.0-rc.34: rc.33 had no Office preview, so leaving it out takes nothing away, and each engine left out is well over a hundred megabytes. Shipping means keeping each target's own engine in `platformDirRules` and dropping the exemptions instead.

**Exempt the engines in the payload gate without pruning them.** Rejected: the payloads would ship the engines, and because a `platform-variant` exemption is not directional, the gate would stop reporting them in either payload.

**Disable the `tool-plugin-manager` row by id.** Rejected: that row sits inside the preset's `config.plugins`, so the patch would reach only a top-level row that is already off.

**Rely on the stderr lines alone.** Rejected: they catch only failures that print a known wording. The dump shows that the last layer reached the composed profile, whatever the server printed.

## Consequences

The document tab in the right Sidebar has no Office rendering on the desktop. The built-in `@haoran/dsh-office-preview-notice` registers the four Word and PowerPoint suffixes above the preview's own Office renderer, so opening such a file shows a line telling the user to open it with Office or WPS instead of that renderer's message about enabling a preview service; picking the renderer by hand from the viewer menu still shows that message. An `office-to-pdf` row a user re-enables in their own patch layer starts a provider whose conversions fail, because the payload holds no engine for the kit to resolve.

The boot gate reads only the fragments `LOAD_FAILURE_MARKERS` names. An upstream rewording of those lines passes it silently until the marker list follows; the desktop-layer dump still catches the most likely consequence, a missing last layer.

Every later package the closure brings in that the desktop does not run needs the same decision: withhold it at staging, or prune it per target with an exemption and an absence check.

## Related

[The desktop payload prune gate](2026-08-20-desktop-payload-prune-gate.md) owns the four gate checks and the exemption table; [desktop built-ins on the 0.1.7-rc.2 base](2026-09-26-desktop-builtins-on-the-rc2-base.md) owns the vendored plugin set on the same base; [the desktop installer ships plugins and seeds them into a profile of its own](../feature/2026-08-21-desktop-builtin-plugins.md) owns why built-ins are in the payload.
