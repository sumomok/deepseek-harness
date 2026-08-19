# Agent Note: the closure bundler dropped the darwin native variants

Status: implemented

English | [中文](2026-08-19-darwin-native-variants-dropped-by-closure.zh.md)

## Problem

The first macOS payload built from the converged closure failed its boot gate in
`sharp.mjs:171` with `Could not load the sharp module using the darwin-arm64
runtime`. Comparing the package names in `staging/server` against
`staging/server-mac` showed three platform-suffixed packages leaving the darwin
payload that belong in it — `@img/sharp-libvips-darwin-arm64`,
`@vscode/ripgrep-darwin-arm64`, and `node-addon-require-builtin-darwin-arm64` —
beside the three win32 ones that correctly left.

`bundle-closure.ts`'s `NATIVE` list names five platform-suffixed packages and
all five are win32. The darwin variants were left to survive on reachability,
which only works when some JavaScript requires them statically:
`@koromix/koffi-darwin-arm64` survived for exactly that reason, while a variant
reached through `require.resolve` at call time, or through the dynamic library
search of a `.node`, is invisible to the walk and is deleted as unreferenced
third-party.

Windows never showed the fault. Its four variants are all named in the list, and
its sharp is one package — `libvips-42.dll` ships inside `@img/sharp-win32-x64`,
while macOS splits the library into `@img/sharp-libvips-darwin-*`.

Only sharp was caught, because only sharp loads during boot. Search reaches
ripgrep when a tool runs and the loader reaches
`node-addon-require-builtin` one plugin later, so both would have shipped.

## Decision

`NATIVE` names both platforms' selected variants, derived with `process.arch` as
`PLATFORM_DIR_RULES` already does, and its doc comment states that the symmetry
is what keeps a dynamically resolved variant alive.

That change forces a second one. With `@vscode/ripgrep-darwin-*` in `NATIVE` it
also survives into the Windows payload, and the rule that should have removed it
matched nothing: `{ parent: '@vscode/ripgrep', keep: name => name !== 'bin' }`
addresses a directory that publishes no `bin/` — ripgrep resolves its binary
from a sibling package (`@vscode/ripgrep-<platform>-<arch>`) at call time. The
rule now addresses the `@vscode` scope and selects the sibling, in both target
lists, which also ends the older behaviour where each payload carried the other
platform's `rg`.

`7zip-bin` ships no install script and its extracted binaries carry no
executable bit, so the Windows `after-pack` archiving step failed with `EACCES`
on a machine that installed the dependency for the first time. The hook sets the
bit before spawning.

## Verification

The boot gate passes and reports 38 client modules over the derived darwin
payload. The built `.app` carries `en.lproj` and `zh_CN.lproj`, which is the
separate locale fix in this release.

## Deferred: make the invariant mechanical

Catching this depended on the boot gate happening to load sharp. Two of the
three dropped packages fail only in use, and the same knowledge — which packages
are platform-specific — is encoded twice, once as `NATIVE`'s keep list and once
as `PLATFORM_DIR_RULES`'s discard rules, kept in agreement by hand. Both faults
found today were halves of a hand-written list.

The gate worth adding compares the package names in `staging/server` against
each derived `staging/server-<target>` and fails the build on any disappearing
name carrying a platform marker (`win32`, `darwin`, `linux`, `msvc`, `arm64`,
`x64`) that no explicit discard rule accounts for, printing what it found. A
stronger form derives both lists from family prefixes and the current platform
instead of hand-writing two halves.
