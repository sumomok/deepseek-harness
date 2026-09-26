# Agent Note: Desktop built-ins on the 0.1.7-rc.2 base

Status: implemented

English | [中文](2026-09-26-desktop-builtins-on-the-rc2-base.zh.md)

## Problem

0.1.0-rc.34 moves the desktop onto dsh 0.1.7-rc.2, and three facts about the plugins the installer ships changed with it.

`dsh-at-file` 0.7.0, the third-party `@` file-mention plugin the payload carried as `dsh-at-file-0.7.0-da602d1.tgz`, cannot run on that base. Its host half calls `ctx.settings.register` on the first line of `apply`, and the rc.2 `settings` service no longer has `register`: settings are volatile `Config` fields of a profile entry. The host half fails as a whole, so the `agent/pre-step` injection that puts a mentioned file into the request is gone, while the browser half still offers the `@` menu. Its `settings.yaml` section is named `at-file` and its entry id is `dsh-at-file`, so the one-time import of that file cannot place the section either. Upstream's own web app has shipped `@` references since the 0.1.5 base: the composer's `ui-reference` menu, whose file candidates `file-reference-local` serves.

The thirteen other built-ins peer on workspace packages the old tarballs did not use: the settings, chat, conversation and slot client packages, the remotes and session-controller APIs, and `agent-preset-registry`. `apps/desktop-server/package.json` did not declare them, and `pnpm-lock.yaml` sets `autoInstallPeers: true`, so pnpm installed each undeclared peer from the npm registry beside the workspace package of the same name.

Each of those thirteen had to be rebuilt against rc.2 anyway, and two of the tarballs they replace could not be rebuilt from any commit: the rc.33 `@haoran/dsh-auto-compact` archive was packed from an uncommitted working tree, and its manifest and the gateway's were laid out differently from the other eleven.

## Decision

**`dsh-at-file` is withdrawn, and upstream's `@` references take its place.** The tarball, its `file:` specifier, its notices override, and its README row are deleted, and the name moves from `BUILTIN_WEB_BUNDLES` to `WITHDRAWN_WEB_BUNDLES` in [`apps/desktop-shell/src/profile-seed.ts`](../../../../apps/desktop-shell/src/profile-seed.ts), the third entry after `@sumomok/dsh-edit-rerun` and `dsh-better-sidebar`. On rc.2 the server skips a `dsh.profile.bundles` name it cannot resolve and writes one `skipping profile bundle` line to stderr on every boot, so the entry is what takes the name out of every profile an earlier build seeded; `pruneWithdrawnBundles` removes it only where it no longer resolves and removes only the link this shell made. `@` mentions of files and sessions are the web app's `ui-reference` row, which a profile turns off the way it turns off a built-in's row.

**Every workspace package a built-in peers on is a `workspace:*` dependency of `apps/desktop-server`.** Sixteen are added: `@deepseek-ai/dsh-agent-preset-registry`, `-api-remotes`, `-api-session-controller`, and thirteen `@deepseek-ai/dsh-client-*` packages. With them declared, pnpm links each peer to the workspace package the server itself runs, and the registry copies leave the lockfile, including the `dsh-typert-protocol` 0.1.2-rc.1 copy the old tarballs pulled in. The specifier is `workspace:*` rather than `workspace:^` because upstream's workspace-protocol hygiene check rejects any other range for a `@deepseek-ai/dsh-*` dependency, and a private app is not exempt from it.

**All thirteen built-ins are repacked from one commit of the plugin repository, whether or not their source changed.** They are built and packed from that commit under one recorded toolchain (Node 24.15.0, pnpm 10.15.0, Darwin arm64). A second pack of the same commit in a separate worktree must give byte-identical archives before any of them is vendored. The source commit, the toolchain, and each archive's sha256 are recorded in the vendoring commit's message, so every vendored tarball can be rebuilt from a commit someone else can fetch. The versions are gateway 0.5.0, auto-compact 0.3.0, desktop-update 0.2.0, plugin-updates 0.3.0, mcp-servers 0.2.0, balance 0.6.0, clickable-refs 0.5.0, screenshot 0.6.0, connection-banner 0.3.0, quote-message 0.4.0, vision-switch 0.3.0, btw 0.2.0, and default-model 0.3.1.

## Alternatives considered

**Keep `dsh-at-file` and wait for its author to move to volatile `Config`.** Rejected: the plugin lives in a third-party repository with its own release cadence, and until it changes, the shipped archive's host half fails on every launch of an rc.2 build. A composer offering an `@` menu whose mentions never reach the model is worse than no menu.

**Leave the peers undeclared and let pnpm install them.** Rejected: the payload would carry two copies of each such package, the workspace build the server runs and an npm build at whatever version the registry resolved, and which one a plugin's import reaches depends on the directory layout rather than on the installation it runs in.

**Repack only the packages whose source changed.** Rejected: two of the replaced archives could not be rebuilt from any commit, and packing all thirteen in one pass under one toolchain is what makes the reproducibility check cover the whole vendored set.

## Consequences

The payload holds thirteen vendored tarballs, twelve of them with a browser half; `@haoran/dsh-default-model` is patch-only. `@sumomok/dsh-balance` 0.6.0 and `@sumomok/dsh-quote-message` 0.4.0 run ahead of npm, which stops at 0.4.0 and 0.3.1.

The `WITHDRAWN_WEB_BUNDLES` entry must stay while any installation at 0.1.0-rc.33 or earlier may still upgrade into this build. Dropping it earlier leaves the name, and a `skipping profile bundle` line on every boot, in each profile rc.33 seeded.

A `settings.yaml` `at-file` section is not imported by anything here: its entry id matches no row, and mapping its keys onto `ui-reference` and `file-reference-local` is separate work. Until that lands, a user who turned `dsh-at-file` off gets upstream's `@` menu back.

Adding a built-in, or a built-in adding a peer, now also means declaring that peer in `apps/desktop-server/package.json`; an undeclared one reappears in the lockfile as a registry copy rather than failing anything.

Reproducing an archive needs the plugin repository's recorded commit to be fetchable, which is why the branch holding that commit is pushed to a remote before a vendoring commit lands.

## Related

[The desktop installer ships plugins and seeds them into a profile of its own](../feature/2026-08-21-desktop-builtin-plugins.md) owns why built-ins are in the payload and what `WITHDRAWN_WEB_BUNDLES` does to a profile; [withdrawing the vendored right sidebar](../simplification/2026-09-14-desktop-withdraw-better-sidebar.md) is the precedent for withdrawing a third-party built-in; [the vendored plugin reference gate](2026-09-03-vendored-plugin-reference-gate.md) owns the check that the manifest, the notices overrides, and the README tables name the same archives.
