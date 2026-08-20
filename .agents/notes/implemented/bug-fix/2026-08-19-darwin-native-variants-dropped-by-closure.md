# Agent Note: the closure bundler dropped the darwin native variants

Status: implemented

English | [中文](2026-08-19-darwin-native-variants-dropped-by-closure.zh.md)

## Problem

The first macOS payload built from the converged closure failed its boot gate in `sharp.mjs:171` with `Could not load the sharp module using the darwin-arm64 runtime`. Comparing the package names in `staging/server` against `staging/server-mac` showed three platform-suffixed packages leaving the darwin payload that belong in it — `@img/sharp-libvips-darwin-arm64`, `@vscode/ripgrep-darwin-arm64`, and `node-addon-require-builtin-darwin-arm64` — beside the three win32 ones that correctly left.

`bundle-closure.ts`'s `NATIVE` list names four platform-suffixed packages and all four are win32. The darwin variants were left to survive on reachability, which only works when some JavaScript requires them statically: `@koromix/koffi-darwin-arm64` survived for exactly that reason, while a variant reached through `require.resolve` at call time, or through the dynamic library search of a `.node`, is invisible to the walk and is deleted as unreferenced third-party.

Windows never showed the fault. Its four variants are all named in the list, and its sharp is one package — `libvips-42.dll` ships inside `@img/sharp-win32-x64`, while macOS splits the library into `@img/sharp-libvips-darwin-*`.

Only sharp was caught, because only sharp loads during boot. Search reaches ripgrep when a tool runs and the loader reaches `node-addon-require-builtin` one plugin later, so both would have shipped.

## Decision

`NATIVE` names both platforms' selected variants, derived with `process.arch` as `PLATFORM_DIR_RULES` already does, and its doc comment states that the symmetry is what keeps a dynamically resolved variant alive.

That change forces a second one. With `@vscode/ripgrep-darwin-*` in `NATIVE` it also survives into the Windows payload, and the rule that should remove it matches nothing: `{ parent: '@vscode/ripgrep', keep: name => name !== 'bin' }` addresses the contents of a package that publishes no `bin/` — ripgrep resolves its binary from a sibling package (`@vscode/ripgrep-<platform>-<arch>`) at call time.

That discard rule predates the closure converger, and on the baseline it was written against, each payload carried the other platform's `rg`: the dead rule sits in the `win` list, which lets `@vscode/ripgrep-darwin-arm64` through, and the `darwin` list names no `@vscode` rule at all, which lets `@vscode/ripgrep-win32-x64` through. The converger hid half of that by deleting the darwin variant as unreachable, leaving the mac payload alone in carrying a foreign `rg`, and returning the darwin variant to `NATIVE` brings the hidden half back. The rule now addresses the `@vscode` scope and selects the sibling, one entry per target list, which ends both halves. Between the two baselines the rule's input changed, not the rule.

`7zip-bin` ships no install script and its extracted binaries carry no executable bit, so the Windows `after-pack` archiving step failed with `EACCES` on a machine that installed the dependency for the first time. The hook sets the bit before spawning.

That failure belongs to a class worth naming, because the specific fact generalizes badly and the class does not. Anything that depends on a file attribute an unpacked dependency carries — an executable bit here, a symlink or a case-sensitive name next time — is correct on a development machine that installed the dependency incrementally, and wrong only after a clean install. Clean installs happen on CI runners and on new machines, which are the two places where a failure is least convenient to debug. A dependency newly added to the build path is where to expect it.

## Verification

The boot gate passes and reports 38 client modules over the derived darwin payload. The built `.app` carries `en.lproj` and `zh_CN.lproj`, which is the separate locale fix in this release.

The package names of the two derived payloads carry the rest of the evidence. `staging/server-mac` keeps `@img/sharp-darwin-arm64`, `@img/sharp-libvips-darwin-arm64`, `@koromix/koffi-darwin-arm64`, `@vscode/ripgrep-darwin-arm64`, `node-addon-require-builtin-darwin-arm64`, and `node-pty/prebuilds/darwin-arm64`; `staging/server-win` keeps `@img/sharp-win32-x64`, `@koromix/koffi-win32-x64`, `@vscode/ripgrep-win32-x64`, `node-addon-require-builtin-win32-x64-msvc`, and `node-pty/prebuilds/win32-x64`. Neither payload holds a package belonging to the other platform, and the darwin side carries one entry more because macOS splits libvips out. That covers what the boot gate cannot: the gate loads sharp alone, while these names show that the two packages failing only in use are present in the darwin payload and that each payload carries exactly one `rg`.

## Deferred: make the invariant mechanical

Catching this depended on the boot gate happening to load sharp. Two of the three dropped packages fail only in use, and the same knowledge — which packages are platform-specific — is encoded twice, once as `NATIVE`'s keep list and once as `PLATFORM_DIR_RULES`'s discard rules, kept in agreement by hand. Both faults found today were halves of a hand-written list.

The gate worth adding compares the package names in `staging/server` against each derived `staging/server-<target>` and fails the build on any disappearing name carrying a platform marker (`win32`, `darwin`, `linux`, `msvc`, `arm64`, `x64`) that no explicit discard rule accounts for, printing what it found. A stronger form derives both lists from family prefixes and the current platform instead of hand-writing two halves.

## Alternatives considered

**Teach the reachability walk to follow dynamic resolution.** Give the walk call-site recognition for `require.resolve` and `import.meta.resolve` instead of maintaining a keep list. It shortens the list without replacing it. `@img/sharp-libvips-darwin-*` is caught: `@img/sharp-darwin-arm64/index.cjs` names it in a literal `require.resolve`, which is what upstream puts that call there for, and the dynamic library search only finds the `.dylib` inside the package. `@vscode/ripgrep-darwin-*` and `node-addon-require-builtin-darwin-*` are not: neither parent package names its variant in any JavaScript, only in `package.json`, which is not a specifier the walk reads. The keep list is what covers those two.

**Add `@img/sharp-libvips-darwin-arm64` alone.** The boot gate names exactly that package, and the smallest fix stops there. The other two fail only in use — search reaches ripgrep when a tool runs, and the loader reaches `node-addon-require-builtin` one plugin later — so the smallest fix hands two latent failures to users, while the package-name difference already named all three.

**Derive both lists from family prefixes and the current platform**, rather than hand-writing each platform's selected variants. This is the stronger form and it loses on timing alone: it rewrites how both `NATIVE` and `PLATFORM_DIR_RULES` are written, and this branch is cutting a release. `## Deferred: make the invariant mechanical` records it as the shape the mechanical gate should take.

**Patch `7zip-bin` or add a postinstall step**, rather than calling `chmodSync` in the hook. It loses on maintenance cost: a patch file has to be reapplied at every dependency bump, while the chmod at the call site is idempotent and survives a version change or a fresh lockfile resolution.

## Consequences

The darwin payload passes its boot gate and runs, reporting 38 client modules. Each payload carries only its own platform's `rg`, so the mac payload holds no Windows binary. The Windows `after-pack` step archives successfully on a machine that installed the dependency for the first time, which is the state of CI runners and new machines.

The cost is that the same knowledge — which packages are platform-specific — is now encoded explicitly twice, as `NATIVE`'s keep list and as `PLATFORM_DIR_RULES`'s discard rules, kept in agreement by hand. `NATIVE` names both platforms in full instead of naming win32 and leaving darwin to reachability, so a new native dependency has to be added on both sides, and adding it on one side reproduces this failure. The trade is taken deliberately: what ships stops depending on whether some module happens to require a variant statically, and the deferred section above holds the route to making the agreement mechanical.

`NATIVE`'s darwin half carries one entry more than its win32 half, because macOS splits libvips into its own package. That asymmetry is real, not an omission.
