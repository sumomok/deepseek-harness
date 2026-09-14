# Agent Note: Withdrawing the vendored right sidebar

Status: implemented

English | [中文](2026-09-14-desktop-withdraw-better-sidebar.zh.md)

## Problem

The desktop shipped two right-hand sidebars at once. Upstream's `ui-sidebar-right` is part of the in-box web app and registers its 「打开侧边栏」 button into the `conversation.session.header.corner` slot ([`packages/client/ui-sidebar-right/src/client/index.ts`](../../../../packages/client/ui-sidebar-right/src/client/index.ts)). The vendored `dsh-better-sidebar` mounted a second panel beside it — its own `<div data-dsh-better-sidebar>` appended straight to `document.body` rather than a slot registration — whose 「展开侧边栏」 and 「展开底部面板」 toggles float over that same corner. One screen edge, two panels, two sets of controls, and nothing that could reconcile them: the plugin's surface is outside the slot system the header corner arbitrates.

## Decision

0.1.0-rc.33 ships one right-hand sidebar, and it is upstream's. `dsh-better-sidebar` leaves the payload entirely: the tarball under `apps/desktop-server/vendor/`, its `file:` specifier in [`apps/desktop-server/package.json`](../../../../apps/desktop-server/package.json), and the `dsh-better-sidebar>node-pty` override in [`pnpm-workspace.yaml`](../../../../pnpm-workspace.yaml) are all deleted. That override existed for this plugin alone; the harness core's own `node-pty` pin at `1.2.0-beta.15` and `patches/node-pty@1.2.0-beta.15.patch` are untouched by it going.

The name moves from `BUILTIN_WEB_BUNDLES` into `WITHDRAWN_WEB_BUNDLES` in [`apps/desktop-shell/src/profile-seed.ts`](../../../../apps/desktop-shell/src/profile-seed.ts) rather than simply disappearing from both. The server resolves every name in `dsh.profile.bundles` and fails the boot on one it cannot resolve, so a profile seeded by 0.1.0-rc.32 would refuse to start under a build that dropped the name silently. `pruneWithdrawnBundles` takes the entry out of the manifest and removes the flat-fallback link this shell made for it, and only the shell's own leavings go: a link into anything other than this build's payload stays, and so does the bundle entry whenever the package still resolves, so a copy installed with `dsh plugin --profile desktop-shell add` keeps working under the ownership that put it there. The same launch's `web` profile sync passes a copy living there over with `withdrawn, not migrated`, so a plugin the user installed for the CLI is never pulled into the desktop profile by this change.

The plugin declares no session event of its own — nothing in its sources merges into `SessionEventMap` — so no session log written while it was mounted names a type this build cannot read. Conversations recorded on rc.32 open unchanged.

## Why the upstream sidebar cannot be the one that goes

`sidebarRight` is a required service of the Chat target, not an optional one: [`packages/client/ui-chat/src/client/apply.ts`](../../../../packages/client/ui-chat/src/client/apply.ts) lists it in `inject`, so without a provider the Chat target never applies and the conversation view does not render at all. The same file opens every file link in chat prose through `ctx.sidebarRight.openResource`. Keeping the plugin and turning upstream's panel off would mean forking `ui-chat`, which is the opposite of this fork's standing rule for upstream core.

## What the desktop gives up

`dsh-better-sidebar` 0.18.0-alpha.0 was a workbench rather than a panel, and all of it goes: the lazy-loading file explorer and the CodeMirror editor that saved back to disk, inline preview for images, PDFs and Markdown with Mermaid rendering, real terminal tabs over `node-pty`, a Git panel, an embedded browser, a background-task page, and Side Chat threads. It also published a service other plugins registered sidebar tabs and file viewers on; nothing else in this payload consumed it. Its eight `terminal_*` tools go with it — they were registered only where the user turned on `agentTerminalTools`, off by default — and with them the one shipped tool family whose processes ran on the shell's unscrubbed `process.env` instead of `scrubbedParentEnv()`.

## Alternatives considered

**Hide the plugin's own toggles and keep both panels.** The toggle cluster is rendered by the plugin into a body-level host of its own, so hiding it means a stylesheet targeting another package's internal markup — a rule that breaks silently on the plugin's next release, and one that leaves the second panel, its keyboard shortcuts, and its eight tools all still mounted. It addresses the symptom that prompted the decision and none of the duplication behind it.

**Disable the plugin's row in the seeded patch layer instead of withdrawing the package.** A `disabled: true` row in `@deepseek-ai/dsh-desktop-app`'s layer would stop it mounting while leaving it in the payload, which keeps roughly 7 MB of client bundles, the `node-pty` override, and a plugin the user can re-enable into the same collision. Withdrawal is what actually removes the composition; a disabled row is a default, and this decision is not one users should have to undo.

**Drop the name from `BUILTIN_WEB_BUNDLES` and add nothing.** Every profile rc.32 seeded still lists the name, and `resolveBundleDir` would fail the boot on it, so every upgrading client would come up to a dead application rather than a missing panel. `WITHDRAWN_WEB_BUNDLES` exists for exactly this transition, and `@sumomok/dsh-edit-rerun` is the precedent.

**Vendor a rebuilt plugin with its sidebar panel removed.** The file workbench, terminal, Git panel, and Side Chat all hang off that panel, so what survives the cut is a package with no surface. Carrying a fork of a 0.18.0-alpha plugin to keep a service nothing consumes costs a re-patch on every upstream release for no shipped capability.

## Consequences

The payload loses the plugin and its private closure. Re-locking drops `@codemirror/*`, `cosmokit@1.8.1`, and the unscoped `schemastery@3.18.0` from `pnpm-lock.yaml`, which had no other consumer; `@xterm/headless` stays, because `packages/terminal/terminal-bash` also depends on it.

The `WITHDRAWN_WEB_BUNDLES` entry must stay while any installation at 0.1.0-rc.32 or earlier may still upgrade into this build. Dropping it earlier does not break a fresh install — it stops repairing the profiles that still name the package, which is the failure it exists to prevent.

The built-in plugin count is stated in prose no parser reads. [`apps/desktop-shell/README.md`](../../../../apps/desktop-shell/README.md) and its Chinese counterpart carry it in five places — how many ship, how many have a browser half and which, what the profile manifest lists, and what the `web` profile already has — and all of them were updated by hand here. The `vendored-plugin-versions` gate covers the table rows only.

## Related

[The desktop installer ships plugins and seeds them into a profile of its own](2026-08-21-desktop-builtin-plugins.md) owns why the built-ins are in the payload and what `WITHDRAWN_WEB_BUNDLES` does to a profile that has one; [the vendored plugin reference gate](../process/2026-09-03-vendored-plugin-reference-gate.md) owns the check that the README tables and the notices overrides agree with the manifest, which is what makes a removed row a hard failure rather than a stale one.
