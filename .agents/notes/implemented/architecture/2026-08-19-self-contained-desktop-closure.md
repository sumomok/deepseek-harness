# Agent Note: The desktop server closure ships collapsed and sealed

Status: implemented

English | [中文](2026-08-19-self-contained-desktop-closure.zh.md)

## Problem

A Windows install spends its time on file count and almost nothing else. [Measured against the real installer](../testing/2026-08-19-windows-install-cost.md), moving the payload's 500.9 MB as 12453 files costs 5.67 s while the same bytes as 10 files cost 0.12 s: 98% of the copy is per-file overhead, at 0.446 ms to create one. The installer pays that count twice, once decompressing into `%TEMP%` and once copying to the install directory, and that is most of the 53.56 s a fresh install took on an NVMe. On a mechanical disk the per-file term grows by two orders of magnitude while the per-byte term grows by one, so the same measurement says the count matters more there, not less.

Of the 12452 files in the package, 12426 were the embedded server closure — Electron, the bundled Node runtime and the app executable are a handful of large files and contribute nothing to the count. Inside the closure, 11008 files across 319 packages were third-party; this repo's own 199 packages held 1417, tsdown already emitting each as an entry plus an invariant module.

Two constraints shape what can be done about it. The runtime is Cordis: `@deepseek-ai/cordis-plugin-loader` resolves plugins **by package name from configuration read at boot**, so a single static bundle has nothing for a configured name to resolve against. And all 219 workspace packages are publishable — none is `private` — so inlining third-party code into them at build time would change what npm consumers receive.

## Decision

Two moves, applied to the copy staged for the installer and to nothing else.

**The third-party trees collapse into the packages that import them.** `scripts/bundle-closure.ts` runs on the derived payload, bundling each `@deepseek-ai/*` package from its own entry points with its dependencies inlined. Our packages stay external to one another, so the loader still resolves `@deepseek-ai/dsh-agent-loop` by name and still finds a directory of that name with an entry in it; only what that entry contains changes. Afterwards, a third-party directory that nothing reachable still imports is deleted.

**What remains of the third party travels as one archive.** `scripts/after-pack.cjs` seals it into `resources/server-deps.7z` and `customInstall` (`build/installer.nsh`) unpacks it with the `Nsis7z` plugin the template already carries. One archive is one file in both of the installer's passes, so those files are created once rather than twice.

The split between the two is by **change frequency**, and it is what keeps the update feed cheap. This repo's packages change every release and stay loose. The feed's differential download is computed over a 7z built non-solid with a 1 MB dictionary, precisely so one changed file invalidates about a dictionary's worth of blocks; sealing packages that change every release into one archive would shift every block after the change and throw that away.

Running after derivation rather than in a build face is what keeps the 219 publishable artifacts untouched — nothing here writes to a package's `lib/` in the workspace. It is also the only place the work can be done correctly: deciding which third-party directory is still needed requires the assembled closure, which a package build does not have.

## What stays loose, and why

**Native modules.** `node-pty`, `koffi`, `sharp` with its `libvips-42.dll`, `@vscode/ripgrep`, and `node-addon-require-builtin`. Their JavaScript builds a path to a `.node` or an `.exe` beside itself, so inlining leaves the loader without the file it looks for.

**Browser artifacts.** The 40 `client.js` bundles the client face emits, which register themselves through `window.__ModuleLoader__.load` when the page evaluates them. They are detected by content rather than by the `./client` export key: what a file is named does not decide whether it runs in a browser.

**This repo's own packages, as directories.** The loader names them.

## Verification

`verifyStagedBoot` boots the derived payload, fetches the index, and then fetches every `/plugins/<id>/client.js` that index names, asserting each still registers through `__ModuleLoader__` and imports no `node:` builtin. Thirty-eight modules pass on a good build; reintroducing the bug that prompted the check fails the build naming `/plugins/@deepseek-ai/dsh-typert-registry/client.js`, which is the module the report came in about.

The seal-and-unpack round trip was measured directly: 5443 files in, 1289 shipped, 5443 out, and the reconstructed closure boots and serves the same 12076-byte index as the original.

Differential download was measured rather than assumed, with `scripts/measure/diff-download.mjs` doing electron-updater's own arithmetic over two blockmaps:

| change | downloaded | of 136 MB |
|---|---|---|
| a package of ours, loose | 192 KB | 0.14% |
| a dependency, inside the archive | 5.2 MB | 4% |

The second number retired a worry rather than confirming it: a change inside the archive was expected to shift every block after it and force a full download, and it invalidates about 30% of the archive's blocks instead, because the blockmap's chunking re-synchronises after a shift.

Installed and run on the reporting machine, and on a mechanical disk elsewhere, where the install is "slightly slower, comfortably acceptable".

## Alternatives considered

**A `DSH_BUILD_FACE deploy` build face.** The original proposal: emit self-contained artifacts from the package build, beside the existing `host` and `client` faces. Rejected once the work was real. It would have to write to each package's `lib/`, which is what npm publishes, so keeping the published artifacts identical would mean maintaining two outputs of every package. And it cannot do the second half at all: which third-party directory is still reachable is a property of the assembled closure, not of any one package's build.

**Bundle the whole server entry into one file.** The smallest possible closure, and the one thing the Cordis loader cannot work with, since configuration names plugins that must exist as resolvable packages at runtime.

**Seal the whole closure, not just the third party.** Simpler, and it would take the file count lower still. Rejected on the differential download: our packages change every release, and sealing them would move a routine update from 192 KB to the whole payload.

**Bundle each third-party package in place.** Rewriting the deployed closure package by package rather than bundling from our own entry points. Rejected: third-party `exports` maps are arbitrary and consumers import subpaths, so preserving every reachable subpath of 319 packages written by other people is a much larger surface than bundling an import graph that is ours.

**Prune harder.** The pipeline already drops 19469 files by suffix, platform and documentation sidecar. What remains is runtime JavaScript the server loads.

## Consequences

The payload is 12452 files down to 1289 shipped, unpacking to 5443. The installer is 132.9 MB against 144.2 MB, and the closure 106 MB against 135 MB — bundling removes more by tree-shaking than inlining duplicates add, which is the opposite of what was expected of it.

The deepest relative path is 166 characters against 190, because `@earendil-works/pi-ai`'s nested tree is gone. The installer's extract budget had four characters of headroom and now has about twenty-eight, so [the MAX_PATH cliff](../bug-fix/2026-08-19-windows-update-max-path-uninstall-loop.md) is no longer one step away.

Two packages do not bundle — `@deepseek-ai/dsh-client-ui-primitives` and `@deepseek-ai/schemastery` — and keep every file they had. That costs file count and nothing else, and it is reported by the pipeline rather than being silent.

Three traps are worth carrying forward, because each cost a diagnosis:

`node-addon-require-builtin` is a native addon whose name does not say so. The loader reaches Node's own module graph through it to set `loader.internal`, and inlining it made the boot fail one plugin later with `--expose-internals is required`, naming a flag that was never involved.

Deleting a third-party directory needs the reachable set, not one scan. `@babel/code-frame` survives because something imports it, and it needs `picocolors`, which nothing else names; a single pass deletes the dependency of a package it just kept.

A browser artifact must not be rebundled for Node. Doing so put an `import ... from 'node:module'` on top of forty client bundles: the registration was still in each file and the page never reached it, and every server-side check stayed green. That failure is why the boot gate now reaches into the renderer.
