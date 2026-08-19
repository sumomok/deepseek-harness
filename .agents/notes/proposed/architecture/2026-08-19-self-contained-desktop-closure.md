# Agent Note: A self-contained deploy face for the desktop server closure

Status: proposed

English | [中文](2026-08-19-self-contained-desktop-closure.zh.md)

## Problem

A Windows install spends its time on file count and almost nothing else. [Measured against the real installer](../../implemented/testing/2026-08-19-windows-install-cost.md), moving the payload's 500.9 MB as 12453 files costs 5.67 s while the same bytes as 10 files cost 0.12 s: **98% of the copy is per-file overhead**, at 0.446 ms to create one and 0.151 ms to delete one. The installer pays that cost twice, once decompressing into `%TEMP%` and once copying to the install directory, which is most of the 53.56 s a fresh install takes on an NVMe. On a mechanical disk the per-file term grows by two orders of magnitude while the per-byte term grows by one, so the same measurement says file count matters more there, not less.

Of the 12452 files in the package, 12426 are the embedded server closure — Electron itself, the bundled Node runtime and the app executable are a handful of large files and contribute nothing to the count. Inside the closure the split is:

| | packages | files | share |
|---|---|---|---|
| third-party | 319 | 11008 | 89% |
| `@deepseek-ai/*` | 199 | 1417 | 11% |

This repo's own packages are not the problem: tsdown already emits each as `lib/index.js` plus an invariant module and its types, and their `files` lists say so. The 11008 third-party files are what a bundler exists to collapse — `@earendil-works/pi-ai` alone is 1481, `@mixmark-io/domino` 1018, `typebox` 692, `openai` 464, `shiki` 442 and `@shikijs/langs` 363.

The obvious move — bundle the server into one file — is not available. The runtime is Cordis, and `@deepseek-ai/cordis-plugin-loader` resolves plugins **by package name from configuration read at boot**, with `cordis-plugin-include` letting one config pull in another. A single static bundle has nothing left for a configured name to resolve against, and the plugin ecosystem is the product.

The other obvious move — bundle dependencies into each package at build time — collides with publishing. All 219 workspace packages are publishable, none is `private`, and inlining third-party code into them would change what npm consumers receive: duplicated dependencies that npm can no longer dedupe, versions pinned at our build time, and package sizes that have nothing to do with what a library consumer wants.

## Proposal

Add a third build face beside the existing `host` and `client` ones — `DSH_BUILD_FACE deploy` — that emits self-contained artifacts consumed only by the desktop packaging pipeline. The npm artifacts keep their externals and keep being what they are today.

`tsdown.config.ts` already switches on `env.DSH_BUILD_FACE`, and `apps/desktop/scripts/package.ts` already stages the closure through its own `pnpm deploy` step, so the seam exists at both ends. The deploy face differs from `host` in one respect: third-party dependencies are `noExternal`, so each package's entry carries what it imports. Native modules stay external and stay loose, because they are `.node` and `.exe` files that no bundler can inline and whose loaders resolve them by path.

What the closure becomes:

| | now | proposed |
|---|---|---|
| `@deepseek-ai/*` | 1417 files | ~400 (199 packages × ~2) |
| third-party | 11008 files | inlined |
| native binaries | 12 files | 12, unchanged |
| web frontend assets | 90 files | 90, unchanged |
| **total** | **12426** | **~500** |

At the measured 0.446 ms per file created, and two creation passes per install, that is roughly 11 s of the current install returned. On a mechanical disk, where the per-file term is what dominates, the same reduction is worth minutes.

The plugin model is untouched: the loader still resolves `@deepseek-ai/dsh-agent-loop` by name, and still finds a directory of that name with an entry point in it. What changes is only what that entry point contains.

## What must stay loose, and why

**Native modules.** `node-pty` prebuilds, `@koromix/koffi-win32-x64`, `@img/sharp-win32-x64` with its `libvips-42.dll`, and `@vscode/ripgrep-win32-x64`'s `rg.exe` — 12 files, 27 MB. Their JavaScript resolves the binary by constructing a path, so both the loader and the binary must remain real files in a predictable place. These are already the shape the packaging pipeline's `PLATFORM_DIR_RULES` prunes per target.

**Web frontend assets.** `@deepseek-ai/dsh-web-frontend/dist` is 90 files served over HTTP by path. They are data, not modules.

**Anything a package resolves dynamically at runtime.** `shiki` loads grammar and theme files by name; packages that do this cannot be fully inlined and must keep whatever their loader reaches for. This is the class of failure the proposal has to find before it ships, and it is why acceptance rests on a real boot rather than on a file count.

## What a prototype found

`apps/desktop/scripts/bundle-closure.mjs` implements this on the deployed closure rather than in the build face — same shape, faster to iterate — and running it against the staged Windows payload settles three things.

**The prize is real.** 12428 files become 3817, a 69% cut, with 666 of 684 entry points bundling cleanly and only `@deepseek-ai/dsh-client-ui-primitives` and `@deepseek-ai/schemastery` failing outright. What remains is 1421 files of this repo's own packages — of which 190 are `README.i18n.yaml`, pure documentation in a runtime payload and a free win — and about 1780 third-party files still reached by a literal import specifier, dominated by `shiki` and `@shikijs/langs` at 805 between them, which load grammars by name and cannot be collapsed this way.

**The byte risk was wrong, and in the useful direction.** The closure went from 135 MB to 106 MB. Tree-shaking removes more than duplication adds, so the "two or three times the JavaScript" this note warned about does not happen and the first download gets smaller rather than larger.

**The blocker is the framework's self-introspection, and it is worse than "some third-party package does something dynamic".** Two breakages fell out immediately and were fixable: a CommonJS dependency calling `require('events')` inside an ESM bundle, fixed with a `createRequire` banner; and everything else resolving cleanly. The third is not. `@deepseek-ai/cordis-plugin-loader` sets `loader.internal` from `ModuleLoader.fromInternal()`, reading the shape of its own module graph, and a bundled graph is not the shape it reads — `cordis-plugin-hmr` then throws `--expose-internals is required` and takes the boot down after the URL line is already printed. Excluding the six `@deepseek-ai/cordis*` packages from bundling does **not** fix it, so whatever the mechanism reaches, it reaches past the framework's own files.

That last finding is the substance of this round rather than an obstacle to it: the design has to say how a bundled closure keeps the loader's view of itself intact, and until it does, the 69% is not collectable. The boot gate earned its place in the acceptance criteria by catching all three, and the index-content assertion caught the one that printed a URL and then served nothing.

## Alternatives considered

**Bundle each third-party package in place, after `pnpm deploy`.** Rewrite the deployed closure package by package rather than changing how ours are built. Rejected: third-party `exports` maps are arbitrary, consumers import subpaths (`@babel/runtime/helpers/x`, `shiki/langs/js`), and preserving every reachable subpath of 319 packages written by other people is a much larger surface than bundling from our own entry points, where the import graph is ours.

**Bundle the whole server entry into one file.** The smallest possible closure. Rejected: it is the one thing the Cordis loader cannot work with, since configuration names plugins that must exist as resolvable packages at runtime.

**Make the packages themselves self-contained, in the `host` face.** One build instead of two. Rejected on publishing grounds above — it changes 219 public npm artifacts to buy a desktop-only win.

**Prune harder.** The pipeline already drops 19274 files by suffix and platform. What remains is runtime JavaScript that the server actually loads; there is no further prune that is not a bundle.

**Do nothing.** Defensible: 53.56 s on an NVMe is not painful, and the download — the part a user waits on over a network — is already 1% of the payload through the blockmap. The case for acting is the mechanical-disk multiplier and the fact that file count is the only lever this repo controls.

## Acceptance criteria

The deployed closure carries under 1000 files, measured by the packaging pipeline and printed beside the existing longest-relative-path line.

`verifyStagedBoot` passes on the deploy-face payload — a real `web --port 0` boot, the URL line, and an index fetch — which is the gate that catches a bundle that broke a dynamic resolution. Every plugin the desktop composition lists must load, not merely the ones the boot path touches, so the boot check grows an assertion over the loader's resolved plugin set.

Install time is measured before and after with the harness in [the install-cost note](../../implemented/testing/2026-08-19-windows-install-cost.md) — the real installer, observed only through constant-time calls, quoting the interval between the "installing" and "complete" pages.

The npm artifacts are byte-identical to what the `host` face produces today, proving the deploy face changed nothing that ships to package consumers.

MAX_PATH headroom improves rather than regresses: collapsing `@earendil-works/pi-ai`'s nested tree removes the 208-character path that leaves the current payload 4 characters from the installer's extract budget.

## Risks

**The framework reading its own module graph.** The one the prototype hit and did not solve; see above. Everything below is secondary to it.

**Dynamic resolution inside third-party packages.** A package that reads its own files by path, or `require`s a name computed at runtime, breaks silently under bundling and may break only on a code path the boot check does not reach. Mitigation is the plugin-set assertion above plus the existing snapshot suite, and the honest position is that this risk is what makes the change a separate round rather than a rider on something else.

**Byte growth — measured, and it does not happen.** The worry was that inlining duplicates shared dependencies and multiplies the JavaScript. The prototype closure came out at 106 MB against 135 MB: tree-shaking takes out more than duplication puts in. This risk is retired, and the first download gets smaller rather than larger.

**Duplicated dependencies at different versions.** Already true and already correct: five of the nested trees checked hold a *different* version from their top-level twin. Inlining per package preserves exactly the version each package resolved, which is more faithful than the flattening a naive hoist would do.

**Two faces to keep honest.** A build face that only the desktop uses is a path that ordinary development does not exercise, and it can rot. The acceptance criterion that npm artifacts stay byte-identical is what keeps the two from drifting into different behavior unnoticed.
