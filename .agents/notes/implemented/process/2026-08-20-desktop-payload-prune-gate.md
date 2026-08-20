# Agent Note: What the desktop payload prune is allowed to delete

Status: implemented

English | [中文](2026-08-20-desktop-payload-prune-gate.zh.md)

## Problem

The desktop payload is cut from a 35000-file staged closure to 3858 files by two independent passes, and [collapsing the third-party trees](../architecture/2026-08-19-self-contained-desktop-closure.md) is the larger of them. `PLATFORM_DIR_RULES` in `apps/desktop/scripts/package.ts` drops the other platform's artifact directories during the copy; the reachability walk in `apps/desktop/scripts/bundle-closure.ts` inlines each `@deepseek-ai/*` package's dependencies and then deletes every third-party directory nothing still imports. Both decide by static evidence — a predicate over directory names, or a specifier following `from`, `require` or `import` — and neither reports a deletion it cannot explain.

A package whose name is produced at run time has no static evidence. Three were deleted in one day:

| deleted | why nothing saw it | how it would have surfaced | how it actually surfaced |
|---|---|---|---|
| `@vscode/ripgrep-<platform>-<arch>` | `lib/index.js` builds the name from `process.platform` and `process.arch` | search finds no binary | someone went looking |
| `@img/sharp-libvips-darwin-*`, `@vscode/ripgrep-darwin-*`, `node-addon-require-builtin-darwin-*` | reached only by `require.resolve` or by a `.node`'s own library search | boot fails in `sharp.mjs`; the other two wait for search and for a later plugin | the boot gate happens to load sharp |
| `open` | `import.meta.resolve('open')` puts the name after neither `from`, `require`, nor `import` | `ERR_MODULE_NOT_FOUND` at payload import | the build failed outright |

Two of the three were caught by luck. The ripgrep and `node-addon-require-builtin` deletions in the middle row fail only when a user searches or loads the plugin that needs them, and would have shipped; [the record of that one](../bug-fix/2026-08-19-darwin-native-variants-dropped-by-closure.md) is where a gate over the payload's package names was first asked for.

The ripgrep case is the one that says why a set difference is not enough on its own. `PLATFORM_DIR_RULES` carried `{ parent: '@vscode/ripgrep', keep: name => name !== 'bin' }`, and `@vscode/ripgrep@1.18.0` publishes no `bin/`: the rule matched zero directories and had never matched any. It read as coverage of ripgrep while the sibling packages that hold the binaries travelled unmanaged, and it cost a diagnosis round. Its symptom also changed under it without anyone touching it — before the closure pass, both payloads carried the other platform's `rg`; after, the darwin variant was deleted as unreachable and only the mac payload carried a foreign `rg`. The rule was equally dead in both states.

## Decision

`apps/desktop/scripts/payload-gate.ts` runs four checks, all fatal, and `package.ts` calls them: `verifyPruneRules` once after the staging is verified, `verifyPrunedPayload` on each derived payload before its smoke test and boot gate.

**A prune rule that drops nothing fails the build.** This is the primary criterion. Every `PLATFORM_DIR_RULES` entry is evaluated against the full staged tree for **every** target, not only the one this run builds, because whether a rule matches is a property of the rule table and the tree — which payload a run derives does not enter it. The failure prints the parent's actual entries, so a rule addressed at a package that holds `LICENSE, README.md, lib, package.json` is visibly not addressed at a platform split.

The other three read set differences across the pipeline and are supplementary: a difference moves when upstream changes what it publishes, and upstream can push a hundred commits in two days.

**A package that leaves during the copy must be named by a rule rejection.** Nothing but the platform rules may delete a whole package there.

**A platform-split directory must match the payload it is in.** Directory names whose `-`/`_`/`.` segments carry both a platform (`darwin`, `win32`, `linux`, …) and an architecture (`arm64`, `x64`, …) are the unit: the topmost such directory anywhere under `node_modules`, which covers sibling packages and `node-pty/prebuilds/*` alike. One naming the target must survive to the finished payload; one naming anything else must not be in it. The failure says which pass dropped it — the copy filter or the closure walk — by comparing against the snapshot taken between them.

**Surviving code must not resolve a pruned package by name.** The finished payload is scanned for `import.meta.resolve`, `require.resolve` and `createRequire(…).resolve` called with a string literal; a literal naming a package the prune removed is a finding, printed with the file that resolves it.

### The walk reads resolution calls, and keeps no list for them

`specifierFor` in `bundle-closure.ts` now matches a literal in a resolution call as well as a specifier after `from`/`require`/`import`. That is the whole class — `import.meta.resolve('open')` and `require.resolve('@img/sharp-libvips-darwin-arm64/binary')` both keep their package as a directory, and neither inlines anything. It replaces a `RUNTIME_RESOLVED` keep-list that would have needed one entry per occurrence.

What the walk still cannot see is a name that is not a literal: a template with a substitution (`@img/sharp-${platform}-${arch}`, `@vscode/ripgrep-${process.platform}-${arch}`) and the library search a `.node` performs for itself. `NATIVE` remains the list for exactly those, and both platforms' variants stay named in it.

## Verification

Full `pnpm --filter @deepseek-ai/dsh-desktop run package --mac` on the unmodified branch passes silently: `10 platform prune rules live against the staged tree`, then `94 packages dropped, 15 platform dirs accounted for, 7 runtime-resolved names checked`. No exemption is in force, so the gate prints no exemption line at all.

Each case was reproduced by restoring the defect that caused it and running the pipeline; every one exits non-zero at the gate, ahead of the failure it used to produce.

| restored defect | what the gate says |
|---|---|
| the `{ parent: '@vscode/ripgrep', … }` rule | `[dead-rule] win: … matched 0 of 4 entries`, before any payload is derived |
| no `@vscode` rule on the darwin list | `[platform-variant] @vscode/ripgrep-win32-x64 … rode into the darwin payload` |
| `NATIVE` without its darwin variants | `[platform-variant]` for `@vscode/ripgrep-darwin-arm64` and `node-addon-require-builtin-darwin-arm64` |
| `specifierFor` without resolution calls | `[runtime-resolved] open … node_modules/@deepseek-ai/dsh-web-app/lib/index.js` |

The whole pre-fix state at once produces the dead-rule failure alone, because it fires first; with only that rule repaired, the same state produces all six payload findings, two of them naming `@img/sharp-libvips-darwin-arm64` from both the platform-variant check and the resolution scan.

The resolution-call extension keeps exactly what the retired list did: the closure removes 90 third-party packages with it and 102 without, and the 12 are `open` and its transitive dependencies.

## Alternatives considered

**The set difference alone, with every disappearance required to have a rule.** The first proposal, and it misses the case that prompted the work: the ripgrep sibling packages were in no rule's range at all, while the rule that appeared to own ripgrep did not correspond to them. A dead rule is a defect in its own right and is the one signal that held across both baselines the bug appeared on.

**Scan the surviving payload for any string literal naming a removed package.** It would catch the `open` case, and `open`, `diff`, `debug`, `once`, `send` and `which` are ordinary English words that appear as event names, CSS classes and option keys throughout a node_modules tree. Measured over the payload's 2927 modules, restricting the scan to resolution call sites gives 14 distinct literals and no false positive; the unrestricted form is unusable.

**Keep `RUNTIME_RESOLVED` as a list.** One entry per occurrence, added after each incident. Extending the walk covers the class instead, and leaves one list rather than two.

**Boot the payload harder — run a search, load every plugin.** The boot gate found the sharp deletion because boot loads sharp, and missed the two beside it. Exercising every feature is where that ends, and a deletion still surfaces as whatever the missing package's absence happens to look like rather than as its own name.

**Derive the platform families from `optionalDependencies` metadata.** Precise for packages, and blind to `node-pty/prebuilds/*`, which is a platform split no manifest declares. Reading the segments of a directory name covers both, and over this tree it selects exactly the 15 directories that are platform-split and nothing else.

## Consequences

A payload-pruning mistake is a build failure naming the package, the evidence, and the list to add it to, instead of a boot crash, a feature that silently does nothing, or a report from a user.

The cost is one directory walk of the staged tree, one of each payload, and a read of every module file in the finished payload; against a run that already copies 35000 files and bundles 456 entry points it does not show.

Four kinds of run-time resolution remain outside it. A name assembled from parts and not a platform-split directory — a plugin resolved from configuration by a computed third-party name — is seen by nothing here. A package that was never in the closure is invisible, because every check compares against the staged tree. A platform directory named by only one of the two segments (`prebuilds/darwin`) is not recognised as a variant. And a resolver reached through an alias or a helper (`const r = import.meta.resolve`) defeats the literal scan, as does a name read from a data file at run time.

The checks that read differences also drift with upstream, which is why they are not the primary criterion. `@img/sharp-darwin-arm64` is statically reachable on today's tree because `sharp/dist/sharp.cjs` requires it under a platform switch; on the tree the second row of deletions was found on, it was not. The dead-rule check does not move with that.

`EXEMPTIONS` in `payload-gate.ts` takes a subject per check against a written reason, and a blank reason fails at load. All four tables are empty. Every active exemption is printed at the start of each build, so one whose reason has expired stays visible instead of becoming the gate's resting state.

One host difference is known and not exempted. `stageWindowsVariants` fetches the win32 members of platform-split families on any host, so a macOS staged tree carries both platforms; a Windows host's tree has no darwin members, and the Windows rules would then drop nothing and read as dead. The message names the parent's entries, which is what distinguishes that from a misaddressed rule, and `EXEMPTIONS['dead-rule']` is where a Windows-host build would record it.
