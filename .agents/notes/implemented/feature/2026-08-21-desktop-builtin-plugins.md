# Agent Note: The desktop installer ships two plugins and seeds them into the web profile

Status: implemented

English | [中文](2026-08-21-desktop-builtin-plugins.zh.md)

## Problem

`dsh-better-sidebar` (a file tree, editor, terminal tabs and task list on the right) and `dsh-at-file` (`@` file mentions in the composer) are what makes the desktop client feel finished, and neither reaches a user who installs it. Getting them required a terminal, a working pnpm, and `dsh plugin --profile web add <name>` against a registry — which is how they came to exist on one macOS machine and on no Windows machine at all. Someone who installed the desktop client to avoid a terminal is exactly the person who cannot follow those steps.

Shipping them in the payload is only half the answer, because a profile is user data and the launcher deliberately never revisits it. `initProfile` (`packages/boot/app-boot/src/profile.ts`) writes `$DSH_HOME/profiles/web/` once from `PROFILE_TEMPLATES.web` — `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`, nothing else — and every existing file is left alone forever after. A plugin added to the installation therefore never joins the composition of a profile that already exists, and on a fresh install it joins nothing either, because the template does not name it.

## Decision

The plugins travel in the deploy closure, and the desktop shell puts their names into the profile before it starts the server.

**The closure.** `apps/desktop-server/package.json` declares `dsh-better-sidebar` and `dsh-at-file` at exact versions beside the workspace packages, so `pnpm deploy` materializes them into `resources/server/node_modules` with everything else the server closes over. The installer that carried a build owns those versions; there is no separate update channel for a plugin.

**The versions.** `dsh-better-sidebar` is `0.14.0` from npm, and it is a floor rather than a preference: `0.1.0-rc.8` stopped exposing the `window.__DSH_MODULES__` page global in favour of a `ctx.modules` service, which is how every lazily loaded chunk in `0.13.1` resolved its external dependencies. On any host at or past that release `0.13.1` fails with `[dsh-better-sidebar] chunk "terminal": client module system unavailable` and loses the terminal, editor, and Mermaid panes. `0.14.0` injects `@deepseek-ai/dsh-client-modules` — which this repo has at `0.1.1-rc.1` — shares the plugin's own globals with its chunk copies, and drops the `dsh-client-web-react` and `dsh-client-schema-form` peers rc.8 removed. Its `node-pty` range is unchanged, so the override below still applies as written.

`dsh-at-file` is `v0.6.5` from the author's repository, not npm's `0.6.3`, and the reason is the split resolution below: a bundle's patch layer resolves installation-first through `resolveBundleDir` while its module resolves by the ordinary parent walk, which reaches a profile's own `node_modules` first. Shipping `0.6.3` against a profile that installed `v0.6.5` itself — the state the first machine to run this plugin is in — would pair a `0.6.3` row with `v0.6.5` code.

The dependency names the tag's commit (`289f19bb`), not its archive URL. pnpm records no `integrity` for a GitHub archive tarball, because those bytes are not guaranteed stable, and `pnpm deploy` refuses a lockfile entry that has none — `ERR_PNPM_MISSING_TARBALL_INTEGRITY`, which failed the packaging run outright. A commit is its own hash, so `resolution: {commit, repo, type: git}` pins the contents at least as tightly as a registry `integrity`. Nothing is built at install time: the repository commits its `lib/` and declares no `prepare` script. A registry release at `0.6.5` or later is the reason to move back to a plain version.

**The seed.** `apps/desktop/src/profile-seed.ts` runs in the Electron main process between the orphan sweep and `startServer`, and supplies the two facts a boot needs and nothing else:

- the profile manifest's `dsh.profile.bundles` list carries both names, appended after whatever is already there, so `loadProfile` applies each plugin's `cordis.patch.yml` layer;
- `$DSH_HOME/profiles/node_modules/<name>` links to the payload directory, because the Loader resolves a plugin specifier against the profile directory as `baseUrl` and the flat fallback is the only place on that parent walk an installation-provided package can sit.

The second half is the part that is easy to miss. `resolveBundleDir` resolves a bundle's **patch layer** installation-first, so listing the name is enough for `loadProfile` to succeed and enough for the row to be inserted — and then `entry.init()` imports the plugin by that bare name from `baseUrl` and fails, because nothing on the profile's parent walk holds it. `healProfilesModuleFallback` maintains that same `profiles/node_modules` directory for the CLI app's own dependency closure, which these two are not part of; it only adds names it knows and leaves every other link alone, so the shell's two links survive every boot.

Both writes are additive and idempotent. A name already listed is not appended twice, a link that already points at the right directory is left as it is, and no bundle entry, dependency, or other manifest field is ever removed or rewritten. "Already points at the right directory" is decided by `sameLinkTarget`, which strips the `\\?\` extended-length prefix and normalizes a trailing separator before comparing, and resolves a relative read against the link's own directory: Windows reads a junction back in a form the string that created it never had, so a raw comparison is false for a correct link and every launch would delete and rebuild it. The upstream `ensureSymlink` in `packages/boot/app-boot/src/profile.ts` compares raw and has the same defect. The manifest is replaced by rename, so a launch interrupted mid-write leaves the previous file rather than a truncated one. The whole run reports what it did and the launch logs one line, or none when nothing changed.

**A profile copy is reported, never touched.** When the profile's own `node_modules` holds a built-in at another version, that copy is the code the Loader imports while the patch layer still comes from the installation. The seed appends one warning to its log line — `profile copy dsh-at-file@0.6.3 shadows the shipped 0.6.5 module; patch layer comes from the shipped copy` — and changes nothing: a profile's dependencies belong to whoever installed them, and `dsh plugin --profile web remove <name>` is the user's move to make, not the shell's.

**Nothing here is fatal.** A profile the shell does not recognize is left exactly as it is and the launch continues without the built-in plugins: an unparsable manifest is left for the server's own diagnostic, a manifest declaring no bundle list is treated as a hand-composed profile (appending two names to an absent list would produce a profile that mounts the built-ins and nothing else), a real directory where a link belongs is reported rather than deleted, and a plugin missing from the payload is never named in the manifest — a listed bundle that cannot resolve is a hard boot failure, so the seed only names what it can see. A shell that refuses to launch over a profile it does not understand is worse than one whose sidebar is missing.

## What the profile normalizers do to a seeded list

Two mechanisms rewrite bundle lists, and neither touches these names.

`normalizeShippedProfile` rewrites a profile only when `INSTALLATION_OWNED_PROFILE_TUPLES[name]` exists and the current list matches it exactly. Only `headless` has an entry, so a `web` profile is returned unchanged whatever it holds; even for `headless` the exact-tuple test would fail the moment an extra name is present.

`reconcilePlugins` (`apps/cli/src/plugin.ts`) removes a bundle only when it `wasDependency` — present in the profile's `dependencies` before or after the pnpm run. Seeded names are not dependencies of the profile, so `dsh plugin` operations leave them alone. The one path that does remove one is `dsh plugin --profile web remove <name>` after the user installed that same name themselves, and the next launch seeds it back; disabling the row in `cordis.patch.yml` is the way to turn a built-in off for good, and it is what the README documents.

## One node-pty, not two

`dsh-better-sidebar` declares `node-pty: ^1.1.0` and its own `src/pty-deps.ts` states that it must resolve to the same physical package as the harness core. The core pins `1.2.0-beta.15` exactly, patched by `patches/node-pty@1.2.0-beta.15.patch` for the embedded-runtime spawn helper, and a prerelease is outside `^1.1.0` — so an unforced install produces two copies. That is not merely wasteful in a payload built around file count: `PLATFORM_DIR_RULES` addresses `node-pty/prebuilds` at the top level only, so a nested second copy carries every platform's binaries into both payloads and fails the payload gate, `prunePlatformBuilds` chmods the spawn helper of the top-level copy only, and the nested copy would be the unpatched one the sidebar actually loads.

`pnpm-workspace.yaml` therefore carries `'dsh-better-sidebar>node-pty': '1.2.0-beta.15'`. The versions are API-compatible: `resize` gained an optional third argument and `useConpty` became a documented no-op.

## The build stops editing the developer's harness home

`verifyStagedBoot` boots the derived payload for real, and it did so against whatever `$DSH_HOME` resolved to on the build machine. Two writes followed every build: `prepareProfile` rewrote `~/.dsh/profiles/web/cordis.yml`, and `healProfilesModuleFallback` re-pointed all 171 flat-fallback symlinks at `apps/desktop/staging/server-mac/node_modules`, a tree the next build deletes. Nothing was lost — the next `dsh` launch heals the links — but a build has no business editing the machine's harness state, and the same home leaked into both `--version` smokes.

`package.ts` now wraps its whole run in `withBuildHome`, which creates one `mkdtemp` home, puts it on `process.env` (what `run()` spreads and both `spawn` calls inherit), and removes it in a `finally`.

That changed what the boot gate proves, and for the better. Against the developer's home it loaded whatever that developer had installed; against a fresh one it would have loaded only the two in-box bundles. So the gate seeds its home through `seedBuiltinBundles` — the same call the shell makes — and then requires both built-in plugins among the client modules the served index names. The payload's own copies mounting and serving is now a build assertion rather than something a hand-run smoke test happened to check.

## Keeping the payload's bundler from deleting them

`scripts/bundle-closure.ts` keeps `@deepseek-ai/*` packages resolvable by name and deletes every third-party package nothing reachable imports. Both plugins are third-party by name and imported by nobody — a profile names them in configuration read at boot — so they were deleted before they ever reached a user.

The rule added is structural rather than a name list: a package whose own manifest declares `dsh.bundle` is a profile bundle, is kept whole, and joins the esbuild `external` set. Kept whole, not bundled, because both publish pre-built `lib/` trees whose browser halves must stay exactly as their client build left them. Their own dependencies survive on the existing reachability walk, which now starts from them too; what only the pre-bundled browser artifacts needed — `mermaid`, the CodeMirror packages — is still dropped, since nothing reachable names it. The payload build prints which bundles it kept, because a reachability walk cannot show the survival of something nothing references.

## Alternatives considered

**Add the names to `PROFILE_TEMPLATES.web`.** One line, and it would cover a fresh profile. Rejected twice over: it changes the published `@deepseek-ai/dsh` for every CLI user, who does not have these packages installed and would get a hard boot failure on an unresolvable bundle; and a template is consulted only when the profile does not exist, so every current desktop user — the ones asking for this — would still see nothing.

**Ship a `--patch` overlay from the shell.** `dsh web` accepts overlay patch files, and the shell could pass one that inserts both rows without touching the profile at all. Rejected because the overlay layer sits *above* the user layer: a user could not disable or configure a built-in plugin from `cordis.patch.yml`, which is where every other row is configured. Seeding a bundle name puts the rows in the ordinary place in the stack, below the user's own layer.

**Run `dsh plugin add` from the shell on first launch.** The supported install path, and it needs pnpm on PATH and a reachable registry — the two things the desktop client exists to not need. It would also install a second copy of each plugin per machine, next to the one already in the payload.

**Declare them as dependencies of `@deepseek-ai/dsh` so `healProfilesModuleFallback` links them.** This would remove the shell's symlink half entirely, since the heal walks the CLI app's dependency closure on every boot. Rejected: it puts two desktop-only plugins into the dependency tree of every published CLI install, which is a much larger claim than "the desktop installer carries them".

**Vendor the plugins into the repository.** Full control over their versions and no third-party declaration. Rejected as an ongoing cost with no benefit here: both are published, MIT, and pre-built, and vendoring would fork them away from their upstreams for nothing.

## Consequences

A desktop install now has the sidebar and `@` mentions on first launch, on both platforms, with no terminal. The versions are the installer's: upgrading a built-in plugin means shipping a desktop build, which is the same cadence the rest of the payload already has.

The seed writes to `$DSH_HOME` before the server does. It is confined to two files — `profiles/web/package.json` and links under `profiles/node_modules/` — and it only ever adds, but a shell that edits user data at all is a new fact about this app, and the README says so.

`dsh-at-file` is the one dependency in the payload that does not come from a registry. A commit pin is verifiable, but it also means the package is whatever that repository's tree holds rather than the `files`-filtered publish payload, so the payload carries its `src/`, `tests/` and build config — a handful of small files the suffix prune mostly removes. A registry release at `0.6.5` or later is worth taking when it appears.

The `pnpm-workspace.yaml` override binds the plugin's `node-pty` to the harness core's pinned version. Moving the core's pin means moving this override with it, and the plugin's own compatibility window is what has to be re-checked at that point, not just the harness's.

A profile-local install of the same plugin name now has a split resolution: the Loader imports the profile's copy while `resolveBundleDir` reads the patch layer from the installation. Pinning a built-in to a different version from the profile is therefore unsupported, and the README's limitations section names it.
