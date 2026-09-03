# Agent Note: apps/desktop tests and packaging scripts join the Host aggregate

Status: implemented

English | [中文](2026-09-02-desktop-tests-join-host-aggregate.zh.md)

## Problem

`apps/desktop/tsconfig.json` includes only `src`, and no aggregate covered the package, so `apps/desktop/tests/**` and `apps/desktop/scripts/**` belonged to no TypeScript project. Oxlint runs type-aware rules through tsgolint, which resolves each file to its owning project; for these two directories it reported `Got tsconfig for file …: <none>` and judged them on a degraded default program where `../src/*.ts` imports resolve to `any` or `error`. Those verdicts contradicted `tsc` under `tsconfig.base.json`: `noUncheckedIndexedAccess` makes the non-null assertions that `typescript/no-unnecessary-type-assertion` flagged necessary, so following the lint diagnostic broke the build. `ce5929b494` scoped three rules off for `apps/desktop/tests/**` as a stopgap and recorded the adoption as the follow-up. `apps/desktop/src` was never affected: its own package project always owned it.

## Decision

`tsconfig.host.json` includes `apps/desktop/src/**/*.ts`, `apps/desktop/scripts/**/*.ts`, and `apps/desktop/tests/**/*.ts`, and declares no Project Reference to the package. This is the shape the aggregate already uses for `scripts/**/*.ts` and `website/**/*.ts`: a private, never-published source tree joins the `noEmit` aggregate directly instead of being built as a referenced project. `src` joins so the tests' `../src/*.ts` imports land on files the program lists, which also keeps them resolving to source rather than to emitted declarations — the source-plane rule static gates and tests follow everywhere else. Host is the correct aggregate: the tests and scripts import `node:*`, `js-yaml`, and `@deepseek-ai/dsh-app-boot`, and nothing browser-side.

Oxlint now resolves `apps/desktop/tests` and `apps/desktop/scripts` to `tsconfig.host.json`. It continues to resolve `apps/desktop/src` to the more specific `apps/desktop/tsconfig.json`, which is where that directory already resolved, so this change moves no `src` verdict.

The `apps/desktop/tests/**` override is gone from `.oxlintrc.json`, and `scripts/lint-rule-fingerprint.spec.ts` pins nine overrides again; both files are byte-identical to upstream. Judged on the real program, the three previously exempt rules found three defects, fixed in `apps/desktop/tests/render-service.spec.ts` rather than suppressed:

- Two `expect.any(Number)` values land in a `maxAgeMs: number` position; vitest types the matcher `any`, so they now read `expect.any(Number) as unknown as number`, the idiom `packages/api/session-controller` and `packages/client/modules` tests already use for the same collision.
- One host pattern was built as `` `${'a'.repeat(254)}` ``, a template literal wrapping a string expression; it is now `'a'.repeat(254)`.

`tsconfig.host.json` is upstream-owned but `apps/desktop` is fork-only, so this registration is a fork delta recorded in `.claude/core-patches.md` alongside the retired exception.

## Alternatives considered

**Reference `./apps/desktop` from the aggregate, the way `apps/cli` is referenced.** Rejected: it breaks `pnpm run clean` repository-wide. `scripts/clean.ts:135-139` walks the Project Reference graph from the root solution and requires every project's `outDir` to end in `/types`, throwing `clean: expected TypeScript outDir to end in /types: apps/desktop/lib` from `plan()` before any removal runs. The two apps are not the same shape: `apps/cli` emits declarations to `lib/types`, while `apps/desktop` emits the shipped Electron runtime to `lib`, the path `main: lib/main.js` names. Renaming that output to satisfy the walker would move the packaged entrypoint and every path `electron-builder.yml` and `scripts/package.ts` depend on, to buy declarations the aggregate does not need.

**Widen `apps/desktop/tsconfig.json` to include `tests` and `scripts`.** Rejected: that project has `rootDir: "src"` feeding the same `outDir: "lib"`, so admitting sibling directories requires widening `rootDir` to the package root, which moves every emitted path to `lib/src/…` and breaks the Electron entrypoint. It also contradicts the repository's own placement rule, where a test file belongs to an aggregate and a package project owns only shipped source.

**Add a second project file, `apps/desktop/tsconfig.tests.json`.** Rejected: three include globs in the aggregate reach the same program with no new config to keep in sync, and every other test file in the repository — `apps/cli/tests`, `packages/*/*/tests`, `apps/web/tests` — already lives in an aggregate rather than in a per-directory project.

**Keep the `.oxlintrc.json` exception and leave the directories project-free.** Rejected: the exception silenced three rules but left every other type-aware rule judging desktop tests against unresolved imports, so its verdicts stayed unreliable in both directions, and `apps/desktop/scripts` — the packaging and release pipeline — had no owning project at all.

## Consequences

`pnpm run typecheck` now type-checks the desktop shell's tests and its packaging and release scripts; previously `src` was checked only by `pnpm --filter @deepseek-ai/dsh-desktop run build:ts` at packaging time, and the tests and scripts by nothing. The type-aware lint change is confined to `apps/desktop/tests`: `.oxlintrc.json`'s type-aware overrides glob `apps/*/src/**` and `apps/*/tests/**`, so `apps/desktop/scripts` keeps exactly the non-type-aware rules it already had. Because the aggregate declares no reference to the package, `tsc -b tsconfig.host.json` still emits nothing for `apps/desktop` and `pnpm run clean` keeps working. The stopgap's exit condition is mechanically pinned: re-adding an override to `.oxlintrc.json` fails `scripts/lint-rule-fingerprint.spec.ts`, which pins the inventory at nine.
