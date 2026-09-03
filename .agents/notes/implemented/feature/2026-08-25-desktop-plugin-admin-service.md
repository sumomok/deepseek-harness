# Agent Note: The shell lends its package manager, so a plugin can be updated without a terminal

Status: implemented

English | [中文](2026-08-25-desktop-plugin-admin-service.zh.md)

## Problem

A user on the desktop client can install nothing and update nothing.

Every path into a profile goes through `dsh plugin --profile <name> add <package>`, and `apps/cli/src/plugin.ts` spawns a bare `pnpm` off `PATH` for it. The premise of the desktop client is a person who has no terminal, and the machines it ships to have no package manager: that spawn answers `ENOENT` and the CLI prints `pnpm not found on PATH — install pnpm to manage profile plugins`, which is a sentence for a developer.

That was survivable while a plugin only ever arrived with the application. It stopped being survivable once plugins arrived from outside it. [The one-time migration](2026-08-25-desktop-web-profile-migration.md) brings a user's own `web` profile plugins into the desktop profile, so a desktop install now composes packages that came from npm, that have their own release cadence, and that nothing on that machine can move to a newer version. A plugin with a fixed bug stays broken; a plugin the person installed to get a feature stays on the version that predates it.

Two things make the answer narrower than "add an install button". A profile is user data that a page in the app can reach through `/api`, so anything that installs must not be steerable from there — a caller that could name a specifier could name a git URL and install arbitrary code. And an install has to reach the same registry the machine is configured for: a customer behind a mirror, a proxy, or a private registry has that in `~/.npmrc`, and anything that fetched a URL itself would bypass all three.

## Decision

The shell opens a **second loopback service**, beside [the render service](2026-08-22-desktop-render-service.md) and with a token of its own, and lends the server the package manager the installer ships. `apps/desktop/src/plugin-admin-service.ts` owns it; `@haoran/dsh-plugin-updates` is the plugin that consumes it and draws the Settings tab, and it ships as a built-in from 0.1.0-rc.23, so a fresh install has the tab without having to install something first.

**Two services, not one widened service.** The render token buys pixels from a hidden window and the screenshot tool holds it on every call. Adding install routes behind that same token would have made every holder of it able to change what the application runs. So the shell mints a second 32-byte token, listens on a second ephemeral loopback port, and passes both to the server child alone through `DSH_DESKTOP_PLUGIN_ADMIN_ENDPOINT` and `DSH_DESKTOP_PLUGIN_ADMIN_TOKEN` — never on the shell's own `process.env`, which is also what keeps them out of the environment of the pnpm this service spawns. What the two services share is `apps/desktop/src/loopback-service.ts`: the loopback address, `mintToken`, the constant-time `authorized`, the capped `readBody`, the two answer writers, and `listenLoopback`. Nothing about a route lives there.

**Typert and a Host header were both rejected as the transport.** The mutating call has to be gated, and `PRIVILEGED_METHODS` gates the JSON-RPC surface rather than the Typert gateway, so a Typert-only route would be reachable by anything admitted to `/api`. A Host-header fence is forgeable by a reverse proxy. The loopback listener with a per-launch bearer token is the fence the shell already had a working instance of, and its 404-before-401 ordering means an unauthenticated caller learns nothing about what is offered.

**A caller names a package, never a specifier.** This is the whole security position of the mutating route and it is three separate checks, in the handler, on every call:

- `profile` is matched against `['desktop', 'web']` rather than joined into a path, so no `..` and no absolute path can name a directory.
- `version` must match `EXACT_VERSION` — a bare `major.minor.patch` with optional prerelease and build metadata. pnpm accepts `latest`, `^1.2.3`, `git+ssh://…`, `file:../…`, `npm:other@1.0.0`, and a bare tarball URL in that same position, and every one of them would install code nobody named.
- `name` must be a key of that profile manifest's own `dependencies`, **read from disk in the handler**, never believed from the request and never cached at startup. That set is exactly the packages a profile installed. The built-ins the shell seeds are listed in `dsh.profile.bundles` with no dependency entry, so they are outside the updatable set by construction rather than by a list this code would have to keep current — and so is every package the profile never installed.

**Nothing installs without the person at the keyboard.** `/update` and `/relaunch` open `dialog.showMessageBox` parented to the main window before they do anything. A native modal is the one surface the web UI cannot paint over and cannot answer for, which matters because the page asking for an install is also the page a compromised plugin would draw its own confirmation in. The dialog carries the caller's optional `warning` line flattened of control characters and capped, because that text is composed by a plugin and shown to a person. One install runs at a time; a second is answered 503 rather than queued.

**The pnpm is the shipped one.** `scripts/package.ts` stages the version the repository's own `packageManager` pins — one home for that fact — into `staging/pnpm` with the `npm pack` and extract idiom already used for the Windows native variants. `scripts/after-pack.cjs` copies it to `resources/runtime/pnpm`, beside the bundled Node, because pnpm's published tree contains a `dist/node_modules` and electron-builder's `extraResources` copier hard-excludes node_modules trees — the same reason the server closure travels that way. The service then runs `runtime/pnpm/bin/pnpm.mjs` under `runtime/node`, arguments in an array, never through a shell. It lands under `runtime/` rather than beside the server closure because `bundle-closure.ts`'s sweep deletes anything under `server/` the closure does not reference. A development launch ships no such resource and falls back to `pnpm` on PATH, which is the developer's own and reaches no customer. Nothing fetches a registry URL directly, so the machine's own `.npmrc` serves every request.

**The version on disk is what says an install worked, not the exit status.** This was found by driving the finished feature rather than by reading it, and it was a real defect on every fresh install: `pnpm add` exits **1** with `ERR_PNPM_IGNORED_BUILDS` while installing perfectly, on any profile that has not answered pnpm's build-approval question. Every profile this shell seeds is such a profile — the template writes `nodeLinker` and `autoInstallPeers` and no `allowBuilds` — and any plugin whose tree carries a package with an install script trips it, which `dsh-better-sidebar` does through `node-pty`. Reading the status as the outcome told the person their update had failed while the new version was already on disk, and took the undo record and the restart prompt down with it, after which the row silently rejoined the up-to-date group. So `/update` re-reads the package's own manifest after the run and answers `installedVersion`; the caller compares that with what it asked for. The exit status is still reported, because it names the complaint. This is the same rule the `outdated` route already followed — pnpm exits 1 there precisely when something *is* outdated — applied to the route that changes something.

**A package that stops being a bundle is taken back out.** After a successful install the service re-reads the updated package's manifest. A version that no longer declares `dsh.bundle` still resolves, so `loadProfile` gets past `resolveBundleDir` and then refuses the layer, which ends the boot — the same failure the migration's own repair pass exists for. The name is removed from that profile's `dsh.profile.bundles` and the answer says so. The dependency entry stays: the package is still installed, and this is about what the Loader mounts.

## The reachable surface

Four `POST` routes, all bearer-authenticated, all JSON. `/outdated` and `/peers` are reads that run `pnpm outdated --json` and `pnpm view <name>@<version> peerDependencies --json` in a profile directory and hand back what pnpm printed, parsed but not reshaped, beside `exitCode`, `signal`, and a capped `stderr`. Reporting the exit status rather than interpreting it is load-bearing: `pnpm outdated` exits 1 **precisely when something is outdated**, so a caller reading the status as failure would report nothing exactly when there is something to report. `/update` and `/relaunch` are the two that ask the user first.

The plugin decides which profile a package belongs to, because that decision is about the migration rather than about the shell. It reads the desktop manifest's dependencies, the web manifest's dependencies, and `web-migration.json`, and a name the record holds that the `web` profile still declares is owned by `web` — installing into the desktop profile would replace the shell's link with a second copy and leave the `web` profile, still the one `dsh plugin --profile web` reaches, behind on the old version. **`web-migration.json` is now read by a component outside this repository.** `apps/desktop/src/profile-seed.ts` writes it and the plugin reads it directly; only the `migrated` array is read, and a marker that does not parse is read as no names.

## Alternatives considered

**Ship a `dsh plugin` GUI that shells out to the CLI.** The CLI already owns init, the pnpm invocation, and the reconcile, so the shell would only have to run it. Rejected on the same fact the whole feature exists for: `runPlugin` spawns a bare `pnpm` off PATH, and the machine has none. Making the CLI take a pnpm path would push the shipped-package-manager decision into a binary that has no idea whether one was shipped, and would hand the model a subprocess that installs packages.

**Let the plugin run pnpm itself.** It knows the profile directories and the package names, and the desktop could just tell it where pnpm is. Rejected because it moves the fence into the process the model runs in. The whole point of the exact-version and dependency-membership checks is that they are enforced by something a plugin cannot reach around, and a plugin holding a path to a package manager is a plugin that can install anything.

**Gate the mutating call on Typert with `PRIVILEGED_METHODS`.** No second listener, no second token, no protocol to document. Rejected because that list gates the JSON-RPC surface and not the Typert gateway, so it would not gate this call at all; the fence would have been a comment.

**Fence on the `Host` header instead of a bearer token.** Cheaper than a token, and the loopback bind already limits reach. Rejected because a reverse proxy forges `Host` freely, and this deployment is one a customer may put behind one.

**Refuse an update whose peers this build does not satisfy.** The strongest version of the compatibility check: never install something that says it will not work. Rejected because the range is what a plugin author declared and nothing here can prove it. The harness is on a release-candidate line where `0.1.1-rc.2` does not satisfy `^0.1.0-rc.8` under ordinary semver, so refusing would block most real updates on a rule that is right about the letter and often wrong about the outcome. It warns instead, in one sentence, and the person decides.

**Check nothing about peers.** Simpler, and pnpm installs a mismatched plugin without a word anyway. Rejected because that silence is the problem: a profile turns off `autoInstallPeers` so peers resolve through the flat fallback into the installation, so a mismatch surfaces at the *next launch* — in a window whose Settings page is what the person was just using. One sentence before the install is what turns a mystery into a decision.

**Give the seeded profile template an `allowBuilds` answer, so pnpm exits 0.** It removes the false failure at its source and is two lines. Rejected because the template belongs to `@deepseek-ai/dsh-app-boot` and is compared against `initProfile`'s own output by `profile-seed.spec.ts`, so changing it here means changing upstream and both sides of that comparison — and it would answer a build-approval question on the user's behalf, for packages this shell has not seen. Reading the version on disk fixes the same defect without deciding anything for them, and it covers every other way pnpm can exit non-zero after a successful install rather than the one that was found.

**Update everything at once.** One button, no rows. Rejected because a failed batch leaves a profile in a state nobody chose and there is one undo, not a stack of them.

**Let the browser name the version.** The obvious API, and the tab already knows the version it is showing. Rejected because it puts a specifier on the wire. `update(name)` installs the version the host's own check found, and `rollback()` installs the version the record holds; no version crosses the gateway at all, which is what makes the shell's `EXACT_VERSION` check a second fence rather than the only one.

## Consequences

A desktop user updates a plugin they installed, from Settings, with two clicks and one native confirmation, on a machine with no terminal and no package manager. What they cannot do from there is install something new — that is a catalogue with a different list and a different fence, and it belongs in a tab of its own.

The payload grows by about 19 MB per platform, which is about 4-5 MB once the artifacts are compressed. pnpm publishes as one tarball carrying natives for all four of its platforms, so a macOS build ships the Windows ones too; splitting them would mean re-deriving pnpm's own packaging, and the payload gate does not sweep `runtime/`.

The shell now owns a surface that installs packages, and the audit for it is three lines of validation plus a native dialog rather than a review of the plugin that calls it. `apps/desktop/README.md` states the protocol, which is what a second implementation would build against.

`web-migration.json` became a cross-component file: written here, read by an out-of-repo plugin. Both sides document it. Changing its `migrated` array's meaning is now a change with a consumer.

An install runs pnpm inside a profile directory that also holds symlinks this shell made — the migration'''s links into the `web` profile. Measured on pnpm 11.7.0 with the profile'''s own `nodeLinker: hoisted`, `pnpm add <name>@<version>` leaves those links exactly as they are: a name that is only a bundle entry is not extraneous to it, and a name that is also a dependency entry is satisfied by the version the link resolves to. That is what makes it safe to run an install in a profile the shell partly owns, and it is a property of pnpm rather than of this code, so a pnpm bump is the change that could take it away.

A plugin updated this way takes effect at the next launch. The row says so and offers a restart, because saying "updated" while the running application is still composed from the old copy would be a claim the next launch corrects.

The render service kept every behavior it had. The extraction into `loopback-service.ts` moved `authorized`, `readBody`, `sendJson`, and the listen sequence out of `render-service.ts` and left its `fail` as a thin wrapper carrying the report header; its 91 protocol tests pass unchanged, which is the evidence that the move was mechanical.

## Testing

`apps/desktop/tests/plugin-admin-service.spec.ts` drives the whole protocol against a staged `$DSH_HOME` with pnpm and the dialog both injected, so it runs without Electron and without a package manager: the 404-before-401 ordering, a missing token, a wrong token of the same length, a prefix of the real token, the body cap and the content type, the profile allowlist against a traversal and an absolute path, a package the profile never installed, a built-in name, a name that is a flag or a path, twenty version specifiers that pnpm would accept and this refuses, the five exact versions it takes, the dependency list re-read from disk between two calls, the confirmation text and its buttons, a declined dialog installing nothing, a warning flattened and capped, one install at a time, the bundle entry dropped when the installed package stopped declaring `dsh.bundle` and left alone when it did not, the exit status carried through rather than interpreted, and the packaged-versus-development pnpm launcher.

Three cases pin the rule that the version on disk is the outcome: a run that exited 1 with the requested version installed is reported as installed and still carries the `ERR_PNPM_IGNORED_BUILDS` line, the same run drops a bundle entry the package stopped declaring, and a run that left the old version on disk is reported as installed nothing whatever it exited with.

Two of those cases assert the property the whole surface is bounded by rather than the report: that the token appears in no environment this process holds, and that a second launch mints a different one.

## Related

- [The render service](2026-08-22-desktop-render-service.md) is the first loopback service and the pattern this one follows; the two now share `apps/desktop/src/loopback-service.ts`.
- [The one-time `web` profile migration](2026-08-25-desktop-web-profile-migration.md) writes the marker this feature reads, and is the reason a desktop install holds packages from outside the application at all.
- [The built-in plugin seeding](2026-08-21-desktop-builtin-plugins.md) is why a built-in is a bundle entry with no dependency, which is what puts it outside the updatable set.
