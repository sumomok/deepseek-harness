# Agent Note: The shell's profile moves off the name upstream reserved

Status: implemented

English | [中文](2026-09-11-desktop-shell-profile-rename.zh.md)

## Problem

Upstream 0.1.5-rc.1 reserves the profile name `desktop` for its own Electron application. `rejectElectronProfile` in `apps/cli/src/args.ts` ends the process with `error: profile "desktop" is managed exclusively by the Electron application` for every `--profile desktop` and every `plugin --profile desktop`, case-insensitively, and `apps/cli/tests/args.spec.ts` pins all six forms. Upstream's application owns `$DSH_HOME/profiles/desktop` as a transactional npm project: `apps/desktop/src/paths.ts` joins that exact path, and `apps/desktop/src/project-manager.ts` stages, health-checks, moves and rolls the whole directory back around a bundled pnpm, refusing a manifest whose `name` is not `@deepseek-ai/dsh-desktop-runtime` and a bundle list that does not begin with its own built-ins.

This fork's shell boots that same name. `apps/desktop-shell/src/server.ts` spawns the embedded server with `--profile desktop`, and `apps/desktop-shell/src/profile-seed.ts` creates and maintains `$DSH_HOME/profiles/desktop` before it. On the rc.32 base the spawn is refused at argument parsing, the server exits before printing its URL line, and the shell shows a boot-failure page with no way past it. The rc.32 integration review missed it because no phase of that review launched the shell against the merged base.

The name collision is real beyond the check. A machine that installs both applications would have two owners for one directory: this shell appends to `dsh.profile.bundles` and links packages into `node_modules`, while upstream's manager rejects any manifest it did not write and moves the directory wholesale on every update.

## Decision

**The fork's profile is `desktop-shell`.** `DESKTOP_PROFILE` in `apps/desktop-shell/src/profile-seed.ts` carries the name, the template manifest derives `dsh-profile-desktop-shell` from it, and `ADMIN_PROFILES` in `plugin-admin-service.ts` reads the constant rather than restating the literal. `resolveProfileDir` rejects only an empty name, a separator, `.`, `..`, and `node_modules`, so a hyphenated name needs nothing from upstream; `desktop-shell` is not in `PROFILE_TEMPLATES` either, so the seed remains a precondition of the boot exactly as before.

**An installed client's profile is renamed once, on its first launch of this build.** `adoptLegacyProfile` runs before anything else in `seedBuiltinBundles` and renames `$DSH_HOME/profiles/desktop` onto `$DSH_HOME/profiles/desktop-shell`. One `renameSync` on one volume carries the manifest, the user's `cordis.patch.yml`, `pnpm-workspace.yaml`, `web-migration.json`, every migrated plugin's link and every package the profile installed for itself. The links keep resolving because `ensureLink` writes absolute targets, and the built-ins' links live in `$DSH_HOME/profiles/node_modules`, which is not moved at all.

**The manifest `name` is the whole discriminator, and rewriting it is the one exception to the seed's own rule.** The rename runs only where the new profile has no `package.json` — the same predicate `initDesktopProfile` answers `created` with — and only where the old directory's manifest reads `dsh-profile-desktop`, which is what this shell wrote and what upstream's `@deepseek-ai/dsh-desktop-runtime` never is. Afterwards the manifest's `name` is rewritten to `dsh-profile-desktop-shell`: everywhere else the seed leaves an existing file alone, and this one field names the directory the manifest belongs to, which pnpm reads for every `dsh plugin --profile desktop-shell` command run there.

**A rename that fails leaves the old directory whole and the launch working.** The failure goes into `SeedReport.skipped` rather than `SeedReport.failed`, because `failed` means the one thing a launch cannot absorb — no profile for the server to boot — and this is not that: seeding continues and writes a fresh `desktop-shell`, whose first sync pulls the user's `web` plugins back in. `SeedReport.renamedFrom` carries the old name when the rename happened, and `describeSeed` puts `renamed the desktop profile into place` in `dsh-server.log`.

## Alternatives considered

**Patch `rejectElectronProfile` out of `apps/cli` as a core patch.** One line, and it would ship rc.32 on the name every installed client already has. Rejected because the check is not the problem: upstream's application owns that directory transactionally, so a machine with both installed would have this shell appending to a manifest upstream's manager refuses and upstream moving the directory out from under it. A patch would also retire on upstream's next edit to the same lines, which is a recurring cost for a name this fork does not need.

**Keep `desktop` and reach it some other way.** There is no other way: the check reads the parsed `--profile` value before `resolveBoot`, with no environment variable, no flag, and no API escape past it, and the shell has no supported launch that is not the CLI.

**Copy the old profile instead of renaming it.** A copy has to walk a tree the user may have installed hundreds of megabytes into, and a copy interrupted halfway leaves two half-profiles. `renameSync` on one volume is atomic and moves the whole directory or none of it.

**Pick a name unrelated to the package, such as `dsh-desktop` or `client`.** Any name off `desktop` clears the check. `desktop-shell` matches `apps/desktop-shell` and `@deepseek-ai/dsh-desktop-shell`, which is what someone reading `~/.dsh/profiles/` needs in order to tell which application owns it, especially once the second one is installed.

**Migrate lazily, on the first failure to load the profile.** It would need the shell to read the server's own diagnostic and retry, which is the crash-quarantine ladder rebuilt for a case with a deterministic answer available before the spawn.

## Consequences

**The Updates tab in Settings does not see the renamed profile.** `@haoran/dsh-plugin-updates` 0.2.0 — the vendored tarball in `apps/desktop-server/vendor/` — compiles `DESKTOP_PROFILE = "desktop"` into its host half, reads `$DSH_HOME/profiles/desktop/package.json` and `web-migration.json` directly, and sends `profile: "desktop"` to the plugin-admin service, which now answers `400 profile must be one of desktop-shell, web`. On this build the tab lists no installed plugin and can update none. The built-in plugins are unaffected, because they are seeded rather than installed, and nothing else in the payload names the profile. Closing this needs the plugin rebuilt against the new name and re-vendored; it is not fixable inside this repository.

**Both applications can be installed on one machine.** Upstream's own shell creates and owns `$DSH_HOME/profiles/desktop` on its first run; this one owns `$DSH_HOME/profiles/desktop-shell`. They still share the rest of `$DSH_HOME` — sessions, credentials, settings — which is what they shared before and what the fork's shell has always documented.

**Every command a user runs against the profile changes.** `dsh plugin --profile desktop add <package>` becomes `dsh plugin --profile desktop-shell add <package>`, and the file to edit to turn a built-in off is `$DSH_HOME/profiles/desktop-shell/cordis.patch.yml`. `apps/desktop-shell/README.md`, its Chinese counterpart, and the implemented Agent Notes that carry those commands are updated; the narrative in those notes about what rc.17 did keeps the name that build used.

**The rc.32 integration gate gains a launch requirement.** No phase of the rc.32 review started the shell against the merged base, which is why an upstream check that ends the boot outright reached integration. `.claude/core-patches.md` records it: an integration merge is not reviewed until a real shell-to-server startup smoke has run.

## Testing

`apps/desktop-shell/tests/profile-seed.spec.ts` covers the rename in five cases: a legacy profile with a migrated plugin, an edited patch layer and a migration record is renamed whole with its manifest `name` rewritten and every bundle still resolvable; a `desktop` directory carrying upstream's `@deepseek-ai/dsh-desktop-runtime` manifest is left byte for byte and a fresh `desktop-shell` is seeded beside it; a second launch renames nothing, because the profile it boots is already there; a rename that `rename(2)` refuses — a non-empty directory already at the new path — is reported in `skipped` while the old directory stays whole and the launch still seeds a bootable profile; and a plain file at the new path still produces the `failed` report the seed has always produced.

`apps/desktop-shell/tests/server.spec.ts` is where the regression itself is pinned: a scripted server child records the arguments `startServer` spawned it with, the case asserts they are `--profile desktop-shell --port 0 --no-open`, and it then feeds that same array through `apps/cli`'s own `parseDshArgs`, which answers a profile boot rather than exiting. A profile the launcher refuses fails there rather than at a user's next launch.

A real launch was measured as well: the built `apps/cli/lib/bin.js` was started with `--profile desktop-shell --port 0 --no-open` against a temporary `DSH_HOME` seeded by this shell's own `seedBuiltinBundles`, after a hand-staged `profiles/desktop` was renamed into place by that same run. The server printed its URL line and answered the served index with `200`.
