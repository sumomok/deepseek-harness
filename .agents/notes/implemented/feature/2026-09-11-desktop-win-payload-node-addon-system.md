# Agent Note: Keeping node-addon-system's host variant out of the Windows payload

Status: implemented

English | [中文](2026-09-11-desktop-win-payload-node-addon-system.zh.md)

## Problem

The desktop shell derives each platform's server payload from one staged tree, dropping the directories that hold another platform's binaries. `PLATFORM_DIR_RULES` in `apps/desktop-shell/scripts/package.ts` names those directories per target, and `verifyPrunedPayload` fails the build when a finished payload still carries a variant directory named for a platform it cannot run.

Upstream renamed the native family `node-addon-landlock-run` to `@deepseek-ai/node-addon-system` and added a prebuilt POSIX `flock` binding, which gave the family darwin variants. Landlock is Linux-only, so before that change a macOS build host installed no member of the family and the Windows payload had nothing of it to carry. With flock the host installs `@deepseek-ai/node-addon-system-darwin-arm64`; no rule was addressed at the `@deepseek-ai` scope, so the directory rode into the Windows payload and the first Windows package built on that base stopped at the gate:

```
[platform-variant] @deepseek-ai/node-addon-system-darwin-arm64 names darwin-arm64 and rode into the win payload.
```

## Decision

The `win` list carries one rule addressed at the scope, `{ parent: '@deepseek-ai', keep: name => !name.startsWith('node-addon-system-') }`. The family publishes members for `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64` only, so on Windows every one of them is a binary the payload cannot run; the trailing `-` keeps the entry package `@deepseek-ai/node-addon-system` itself, which is plain JavaScript both call sites live in.

Dropping the variants leaves Windows behavior unchanged, because on win32 the entry package never resolves one. `loadBinding` in `native/system/packages/entry/src/flock.ts` throws `ERR_FLOCK_UNSUPPORTED_PLATFORM` for any platform other than linux and darwin, ahead of `require.resolve`. `launcherPath` in `src/index.ts` catches an unresolvable variant and returns the path pnpm's layout would use, which simply does not exist; `probe` is the single availability signal and reports `unusable` for a missing binary exactly as it does for an unenforcing kernel. Both sites build the specifier from `process.platform` and `process.arch` in a template literal, so the gate's `runtime-resolved` scan — literal arguments only — does not name the family either.

The rule is asymmetric on purpose. `verifyPruneRules` fails a rule that drops nothing, and a darwin counterpart would drop nothing: npm's `os`/`cpu` fields put exactly one variant on a macOS host, `node-addon-system-darwin-<arch>`, and that is the one variant the macOS payload must carry.

## Alternatives considered

**A symmetric `darwin` rule, for the "both lists name the same parents" convention.** Rejected: on the mac build host the scope holds only the variant the mac payload keeps, so the rule matches zero entries and `verifyPruneRules` fails it as a dead rule. The convention guards families with members on both sides; this family has none on win32.

**Exempt the finding in `EXEMPTIONS['platform-variant']`.** Rejected: an exemption silences the report while the macOS binding still ships inside the Windows installer. The finding is correct; the payload was wrong.

**Publish a win32 member of the family.** Rejected: flock is POSIX and the launcher is Landlock; there is no Windows implementation to build, and adding an empty package to satisfy a copy filter is freight with a version number.

**Address the rule at `@deepseek-ai/node-addon-system`.** Rejected for the reason `@vscode` is addressed as a scope: the variants are sibling packages under the scope, not children of the entry package, so a rule addressed at the entry package matches nothing.

## Consequences

The Windows payload no longer carries the macOS flock binding, and Windows packaging proceeds past the payload gate. `flock` on Windows keeps throwing `ERR_FLOCK_UNSUPPORTED_PLATFORM` and the Landlock launcher keeps probing `unusable`, both as before.

The rule assumes a POSIX build host. On a Windows host no member of the family installs, the scope holds only the entry package, and this rule would itself become a dead rule. That case does not arise today — the fork packages both platforms from macOS — and the failure would be the gate's loud dead-rule finding rather than a bad payload.

`PLATFORM_DIR_RULES` has no unit test: `package.ts` runs `main()` at import, so the table is not importable, and the coverage gate's `packages/*/*/src` scope does not reach `apps/`. Its evidence is the build itself — `verifyPruneRules` proves every rule drops something in the staged tree, and `verifyPrunedPayload` proves each finished payload carries only its own platform's variants.
