# Agent Note: The fork's desktop shell vacates apps/desktop

Status: implemented

English | [中文](2026-09-10-fork-shell-vacates-apps-desktop.zh.md)

## Problem

Upstream 0.1.5-rc.1 ships an Electron shell of its own at `apps/desktop`, under the package name `@deepseek-ai/dsh-desktop` — the path and the name this fork's shell has held since it was written. Taking that base in would put two unrelated shells in one directory, where every later upstream change to its own shell arrives as a conflict against fork code that shares nothing with it but the path. The names collide as well: pnpm resolves `apps/*` by manifest name, and one workspace cannot hold two packages called `@deepseek-ai/dsh-desktop`.

Upstream's shell is not a replacement for this one. This shell seeds the built-in plugin bundles into the `desktop` profile, serves the update feed at `https://lhr.ink/dsh-updates/`, signs macOS builds with a self-signed certificate, and carries the login window, the render service, the plugin-admin service and the server-crash recovery ladder the shipped product is built on. Upstream's is a different product: `productName: DeepSeek Harness`, its own artifact names, its own update host.

## Decision

**The fork's shell is `apps/desktop-shell`, package `@deepseek-ai/dsh-desktop-shell`.** The path and the name are free, so upstream's `apps/desktop` arrives as an addition instead of a merge. Everything that named the old path follows it: the host TypeScript program, the workspace-constraints comment, the translation-scope excludes, the vendored-plugin table check, the sibling apps' READMEs, this fork's standing orders, and the implemented Agent Notes that record where the shell's files live. The packaging command is now `pnpm --filter @deepseek-ai/dsh-desktop-shell run package --mac --win`.

**The installed application keeps the name `@deepseek-ai/dsh-desktop`.** Electron takes the application name from the app `package.json`'s `name` field and derives `userData`, `sessionData`, `crashDumps` and the macOS `logs` directory from it; electron-builder derives `updaterCacheDirName` in the generated `app-update.yml` from the same field. The rename alone would move every installation's cookies, login partitions, `Preferences` and `desktop-state.json` out of reach and orphan the updater's download cache, including the `current.blockmap` a differential update reuses. `extraMetadata.name` in `electron-builder.yml` writes the old name into the `package.json` inside the asar, so a packaged build resolves where it does today. `src/app-identity.ts` does the same at runtime for a source-tree launch: it sets the name, then sets `userData` and `sessionData` explicitly, because Electron resolves both during startup, before this package's first line runs.

**Retirement condition.** This package is deleted and `apps/desktop` becomes the shipped client once upstream's shell covers what this one does — seeding the built-in plugin set into the profile, the fork's update feed and self-signed macOS path, the login window, and the render, plugin-admin and crash-recovery services. Whatever ships then either resolves to the same per-user directories or carries a migration; an installed base that loses its data is not an upgrade.

## What the move does not change

- `appId: dev.dsh.desktop` and `productName: DSH Desktop`, and with them the bundle identifier and the `DSH Desktop.app` the installer places.
- The artifact names `DSH Desktop-<version>-arm64.dmg`, `DSH Desktop-<version>-arm64-mac.zip` and `DSH Desktop Setup <version>.exe`, which electron-builder builds from `productName`.
- The update feed: `https://lhr.ink/dsh-updates/mac` and `/win` on `channel: latest`, the two manifests `publish-update.ts` reads back, and the `desktop-v<version>` tag it writes.
- The per-user directories: `~/Library/Application Support/@deepseek-ai/dsh-desktop` and `%APPDATA%\@deepseek-ai\dsh-desktop`, `~/Library/Logs/@deepseek-ai/dsh-desktop`, and the updater cache `@deepseek-aidsh-desktop-updater`.

## Alternatives considered

**Merge upstream's shell onto this one in place.** Two shells that share only a path would interleave file by file in `apps/desktop`, and each upstream release would replay that resolution. The conflict is not one merge's cost but every merge's.

**Adopt upstream's shell now and delete this one.** It does not do what this product ships: the profile seeding, the update feed, the self-signed macOS path, the login window and the three services above have no counterpart there. That is what the retirement condition is for.

**Move the path and keep the package name.** One workspace cannot hold two manifests named `@deepseek-ai/dsh-desktop`; pnpm resolves workspace members by name, and `--filter` would name both.

**Rename the application along with the package and migrate the user data on first launch.** A migration that copies a live Chromium profile has failure modes on every installation it runs on, and it must keep running for as long as any old install can update. Pinning the name has none.

**Pin with `app.setName` alone.** Measured false: with a `package.json` named `@deepseek-ai/dsh-desktop-shell`, `app.setName('@deepseek-ai/dsh-desktop')` leaves `app.getPath('userData')` at `.../@deepseek-ai/dsh-desktop-shell`. Electron resolves `userData` and `sessionData` during startup, so both are set explicitly; the name is still set, because the macOS `logs` directory is resolved on first use and follows it.

## Consequences

The workspace package name and the installed application name differ. Anyone reading the asar's `package.json` or `app.getName()` meets `@deepseek-ai/dsh-desktop`, and both the config line and the module that produce it say why.

Once the base merges, `apps/` holds two shells. Only `apps/desktop-shell` is packaged and published; `apps/desktop` is upstream source the fork does not build.

A future rename of this package must carry the pin with it. `tests/app-identity.spec.ts` fails if the pinned name changes, but the packaged half — `extraMetadata` — has no gate: it is proved by packaging, which this change does not run.

## Testing

`apps/desktop-shell/tests/app-identity.spec.ts` pins the name and both directories against a stand-in `app`. The resolution itself was measured with the built module against the real Electron `app`, launched from a `package.json` named `@deepseek-ai/dsh-desktop-shell`: before the pin, `userData` and `sessionData` were `~/Library/Application Support/@deepseek-ai/dsh-desktop-shell`; after it they are `~/Library/Application Support/@deepseek-ai/dsh-desktop`, `crashDumps` is that directory's `Crashpad`, and `logs` is `~/Library/Logs/@deepseek-ai/dsh-desktop` — the paths the installed build uses today.

The packaged half is unproven here, because this change does not run `package`. The next packaging run must read `resources/app-update.yml` back and find `updaterCacheDirName: '@deepseek-aidsh-desktop-updater'`, and find `@deepseek-ai/dsh-desktop` as the `name` in the `package.json` inside the asar.
