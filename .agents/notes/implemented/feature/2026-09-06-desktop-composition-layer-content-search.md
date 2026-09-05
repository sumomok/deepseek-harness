# Agent Note: A desktop composition layer, opening full-text session search

Status: implemented

English | [中文](2026-09-06-desktop-composition-layer-content-search.zh.md)

## Problem

Sidebar search in the desktop app matched session titles and Workspace names and nothing else. The Host route behind it (`session.search` → `SessionListState.search` → `ctx.sessionQuery.searchSessions`) was mounted and reachable, but `dsh-base` and `dsh-web-app` both configure `session-query-sqlite` with `openAt: never`, which fails every search call with `SESSION_QUERY_SEARCH_DISABLED` before it reaches a request. The browser half then showed `search.unavailable` — "内容搜索暂不可用，仅显示名称匹配。" — on every query. Both bundle rows say in their own comments that content search is opt-in and that a deployment enabling it overrides `openAt` in a later patch layer, and `apps/cli/tests/lazy-search-startup.compat.spec.ts` pins both to `never`, so the value is not the thing to change.

The desktop had nowhere to put that override. Its composition was `dsh-base` + `dsh-web-app` + eleven vendored plugin bundles, every one of which is either upstream source or an out-of-repo tarball, plus `$DSH_HOME/profiles/desktop/cordis.patch.yml`, which is user data the shell writes once and never revisits. A product that ships a browser surface and makes deployment choices for it had no layer of its own to make them in.

## Decision

`apps/desktop-app` (`@deepseek-ai/dsh-desktop-app`) is that layer: a patch-only bundle package — one `cordis.patch.yml` and the `dsh.bundle.patch` manifest field naming it, no code, no `main`, nothing for the Loader to import, since `loadProfile` reads a bundle layer without importing the package. `apps/desktop-server` lists it as a dependency, which puts it in the tree `pnpm deploy` materializes as the Electron app's `resources/server`, and `BUILTIN_WEB_BUNDLES` in `apps/desktop/src/profile-seed.ts` names it, which is what puts it in the desktop profile's `dsh.profile.bundles` and links it into the flat module fallback.

It is named **last** in that list. A profile that already exists gets a missing name appended, so last is the only position a fresh profile and an upgraded one both give it — and it is also the position that matters: the layer then overrides `dsh-base`, `dsh-web-app`, and every built-in plugin layer, while `$DSH_HOME/profiles/desktop/cordis.patch.yml` still applies after it, so a row here is a default the user replaces rather than one they are stuck with.

The one row it carries restates `session-query-sqlite` with `openAt: first-search` and `path: dshHomePath('session-search/desktop.db')`. `first-search` keeps the `node:sqlite` import and the index open out of startup, so a run that never searches pays nothing and Node's SQLite experimental warning stays out of the boot output. The path is durable rather than the shipped `:memory:` because the index is derived, not authoritative: keeping it means the first search of a later run reconciles only new and changed logs instead of rebuilding the whole corpus, which is the difference between paying the build once and paying it on every launch. It is deliberately outside `dshHomePath('sessions')` — the derived index and the session-persistence store are separate stores, and the backend refuses to open a canonical database as its own.

`apps/desktop/tests/desktop-content-search.spec.ts` composes the real `dsh-base`, `dsh-web-app`, and desktop layers through `composeEntries` and asserts the row the desktop profile ends up with, that the shipped pair alone still composes `never`, and that nothing else in the composition moves.

## What the first search costs

The reconcile that runs before the first query lists every persistence snapshot, reads each log it has not indexed, extracts search documents, and commits once. On the corpus this was measured against — 128 session logs, 12.2 MiB of zstd-compressed JSONL, 30.9 MB decompressed — that is one pass over 30.9 MB of JSON. Every search after it in the same run reads nothing it has already indexed, and every run after that reads only what changed.

## Every session log is read, so one unreadable log fails every search

A `SessionEventMap` member is required-on-read: a log carrying an event type the running composition does not know, and not marked `ignorable: true`, makes the reader refuse the whole log with `SessionFormatUnsupportedError`. Under `openAt: never` no bulk read ever happened, so such a log sat dormant. Under content search the reconcile reads all of them, and one refusal aborts the observation, which fails the search with `SESSION_QUERY_PERSISTENCE_FAILED` — not just for that session, for the query.

This is not hypothetical: the corpus above already holds three logs carrying `permissionRules/decision`, an event type no package in this repository or in the desktop payload declares. The failure degrades to exactly today's behavior — the browser half catches it and shows `search.unavailable` with the title and Workspace matches still listed — so the floor is what users have now, not a broken sidebar. It does raise the cost of a third-party plugin that logs a non-ignorable session event: before this change such a plugin broke session replay after uninstall, and now it also turns off content search while its logs are in the corpus.

## Alternatives considered

**Change the `openAt` value in `dsh-base` or `dsh-web-app`.** Both are upstream package source shared with every `dsh web` deployment, both carry comments stating that the value is deliberate and that deployments override it in a later layer, and `apps/cli/tests/lazy-search-startup.compat.spec.ts` pins both. Editing either would enable content search for the CLI's `web` profile as a side effect of a desktop decision.

**Write the row into the desktop profile's `cordis.patch.yml` from `profile-seed.ts`.** The smallest possible edit, and wrong: that file is user data, written only when absent, and `apps/desktop/README.md` documents that the shell never merges into it. Every installation that already has a desktop profile — which is every upgrade — would never see the row.

**Ship a `--patch` overlay file and pass it on the server spawn.** Also small, and it reaches existing installs, but overlays are the last layer `composeProfile` applies: they outrank `$DSH_HOME/profiles/desktop/cordis.patch.yml`, so a deployment default delivered this way is one the user cannot turn off from the file the documentation tells them to edit.

**Put the package under `packages/bundle/` beside the other bundles.** That is where a bundle belongs by group semantics, and it is upstream-owned territory: `packages/bundle/README.md`, `docs/module-graph.md`, and their Chinese counterparts enumerate the packages there, so a fork-only bundle would edit four generated or upstream documents and conflict on every sync. `apps/` holds the fork's own product assemblies already — `apps/desktop`, `apps/desktop-server` — and no documentation catalog enumerates it.

**Add the layer to one of the vendored built-in plugins.** The fork's existing way to add a desktop-only composition row, and the wrong owner for this one: the row belongs to the deployment, not to a plugin, and it would then live in a workspace outside this repository and arrive only through a repacked tarball.

## Consequences

Desktop sidebar search returns ranked content matches with snippets, capped at 20 results, over `user/message` and `assistant/message` events on the `current` surface. Queries stay literal phrases with the `unicode61` tokenizer: FTS5 syntax is data, and a token boundary is a token boundary, so `AI` still does not match `BRAID`.

The app grows one file family under the harness home, `~/.dsh/session-search/desktop.db` plus its WAL sidecars, sized in the order of the extracted message text rather than of the raw logs. Nothing removes it; deleting it costs one rebuild. Startup is unchanged — nothing opens until a search asks — and the first search of each run pays only what changed since the last one.

`BUILTIN_WEB_BUNDLES` now holds twelve names of which eleven are plugins, so `apps/desktop/README.md` and its Chinese counterpart distinguish the two where they counted eleven, and the packaging gate's `seeded.length === BUILTIN_WEB_BUNDLES.length` check covers the new name along with the rest.
