# Agent Note: Bundled library skills

Status: implemented

English | [中文](2026-09-03-bundled-library-skills.zh.md)

## Problem

An agent driving a console built on a component library has to work out, one click at a time, what the library's markup means: which icon glyph deletes a row, which wrapper is the real click target, which control opens a menu instead of submitting. That knowledge is the same on every page of every deployment that uses the library, and it is exactly the knowledge that a session throws away when it ends. A paired trial on one console measured the cost: a hand-written skill took the same task from 30 reads to 7 and from 9 errors to 0.

Two homes for that knowledge were plausible, and only one is legal here. Reading vendor class names in `packages/experimental/content-frame/src/**` would make the harness track a component library's releases and grow one table per library; the package's shipped text deliberately names no library's classes. The other home is a skill: content the model loads on demand, replaceable by a file, and overridable by whoever runs the deployment.

The product owner's ruling on 2026-09-03 removed the third option: v1 ships no user-maintained shared skill root. Library knowledge travels inside a package, and a user's own skills stay separated by the directory boundaries that already exist.

## Decision

`@deepseek-ai/dsh-experimental-library-skills` is a fork-private package whose runtime content is a `skills/` directory of SKILL files plus one composition row. The row is an ordinary `@deepseek-ai/dsh-skill-filesystem` entry configured with `providerName: library-skills`, `includeDefaultRoots: false`, and a `bundledSkillDir` pointing at the package's own `skills/`. No upstream package changes, and the package ships no runtime code: `src/index.ts` is an empty module the repository's package layout requires.

`bundledSkillDir` mounts its root at `BUNDLED_SKILL_RANK` (600), below every user-writable root, and reads through Node rather than `ctx.fs`. A user's same-named skill therefore wins twice over: by layer, because the row sits in the registry's global layer while local discovery belongs to the agent's preset layer, and by rank if a deployment ever puts both in one layer. `customSkillDirs` would have inverted this — rank 300 beats the user's own 400 — so it is not an option for shipped knowledge.

The row lives in five composition files: the package's own `cordis.patch.yml`, which a `dsh plugin --profile <name> add` install activates; the production service-line overlay `packages/experimental/server-sidebar/overlay/customer.patch.yml`; the two e2e overlays that mirror it; and `apps/web/tests/library-skills.overlay.yml`, which composes the row alone. `apps/web/tests/library-skills.e2e.ts` asserts all five carry an identical row, so a composition assembled any of those ways ships the same knowledge.

Every skill in this package carries `user-invocable: false`. The key defaults to true, and the consoles that compose this package also mount `ui-skill`, so a skill without it becomes an entry in the end user's `/` command menu — maintainer vocabulary on a customer-facing surface. Bundled library knowledge is model-facing: the model finds it through the catalog, and a human who wants a slash command writes their own skill in a user root, which wins the name anyway.

The path resolves the package by name from the profile the layer is installed into:

```js
process.getBuiltinModule('node:path').resolve(
  process.getBuiltinModule('node:module').createRequire(baseUrl)
    .resolve('@deepseek-ai/dsh-experimental-library-skills/package.json'),
  '../skills',
)
```

`baseUrl` is the profile directory the row's fiber carries, and `createRequire` searches that directory's `node_modules` and every ancestor — covering both the profile-local install and the shared `$DSH_HOME/profiles/node_modules` mirror.

The row therefore makes this package a deployment dependency of every composition carrying it, and the two ways that dependency can go wrong are not alike. A profile that cannot resolve the package throws `MODULE_NOT_FOUND` while the row's config is interpolated; `boot()`'s `assertEntriesActivated` rejects the failed fiber and the console does not come up. Measured: `dsh --profile web --patch apps/web/tests/library-skills.overlay.yml` against a harness home without the package exits 1 with `Cannot find module '@deepseek-ai/dsh-experimental-library-skills/package.json'`. The quiet mode is the other one — a resolvable package whose `skills/` is missing or empty mounts a root that lists nothing, because `listSkillRootEntriesFromNode` treats an absent directory as no entries. Nothing in the provider reports that, so two things outside it do: the e2e's listing case fails on an empty directory, and the `packageFileExtras` entry forces `skills` into the published `files` list so a tarball cannot ship without it.

Per-user isolation is not part of this. A single-process console separates skill roots by `$DSH_HOME` and by workspace, never by person, and sessions in that console are visible to everyone — so no product surface promises that one user's skills are private. Per-person separation follows for free once each user gets their own `$DSH_HOME` and process; it needs no code.

### Decision gate

| Cell | This decision |
|---|---|
| Principles that already said no | The fork's zero-upstream-change rule removes any edit to `packages/skill/*`, so the landing place can only be a fork package plus composition. "No hardcoded tunables" removes a fixed path constant. "Composition over code" removes a fork-written directory scanner, because `skill-filesystem` already scans, parses frontmatter, and watches. |
| New surfaces | Two: one asset-only package and one composition row. Zero providers, events, tools, routes, config fields, UI surfaces, approval gates, and dependencies. The carrying cost that is real: bilingual README with its pairing record, version alignment, and the `hygiene` gates every package pays. |
| Smallest version that proves it | One placeholder skill, the one row, and four assertions: the skill reaches an agent's catalog, it loads by name, a user's same-named skill replaces it, and removing the row removes it. |
| Seam or hardcode | The mount is a seam that already exists — three existing `Config` fields, one of which is documented for exactly this isolated-provider use. The *content* is deliberately hardcoded as a SKILL and will not become code. One package holds many libraries; the provider scans a whole root. |
| Boundaries | Library knowledge belongs in skills, page and business knowledge in the user's own roots, tool defects on the defect list — mixing them means a package release to fix a sentence about one customer's page. Shipped skills never carry customer data, real record identifiers, hostnames, absolute paths, or credential shapes, because the package reaches every deployment that installs it. Ceiling: no hot update, no per-deployment selection, no A/B; revisit if pure wording changes force more than three releases in a quarter. Ceiling: no per-person visibility until one process per user ships. |

The registrations this package needs are ordinary: a `tsconfig.base.json` path alias, a `tsconfig.host.json` project reference and test include, an `apps/web/tsconfig.json` exclude, index rows in the experimental group README, and the `packageFileExtras` entry in `scripts/check-workspace-constraints.ts`. That last file already carries a ledgered behaviour patch on this fork (`.claude/core-patches.md`, `cd77abb2a5`); this row is a data registration rather than ledger material, but the next upstream sync reconciles both in the one file.

The deployment procedure that has to name the package is `packages/experimental/server-sidebar/README.md`'s Composition section, where the other packages the customer overlay needs resolvable are already listed. It is the only home: no deploy script enumerates them, and the overlay's owning package does not declare them as dependencies either, so inventing a manifest edge here would be a new mechanism rather than the existing one.

## What slice 0 measured

Four facts the design could not settle by reading, each resolved by running:

**`createRequire` in a `!!js` expression resolves a package directory.** It had no precedent in this repository's YAML. A probe against a synthetic profile tree confirmed that `createRequire(baseUrl)` with a directory URL searches both `<profile>/node_modules` and `<profile>/../node_modules`, so one expression covers the profile-local install and the shared mirror. The environment-variable fallback (`!!js process.env.DSH_LIBRARY_SKILL_ROOT`, the form `content-column.patch.yml` uses for its application root) was not needed anywhere, including the e2e lane, where the test creates the same profile link the production install creates.

**An asset-only package does not pass the repository gates as-is.** `verify-package-invariants` needs a `tsconfig.json`; `check-workspace-constraints` needs `main`, `types`, and an `exports["."]` pair pointing at `lib/index.js` and `lib/types/index.d.ts`; the `files` list is derived, so publishing `skills/` requires an entry in that gate's `packageFileExtras` table beside `skill-badge`'s `assets`; and the omitted invariant companion needs its "No … companion is published" sentence in the README. The package therefore carries an empty `src/index.ts`, exactly as `agent-team-profile` does.

**The composed tree puts the row in the global layer and user skills in the preset layer.** `dsh --profile web --dump-config` shows `skill-filesystem` and `tool-skill` disabled by `@deepseek-ai/dsh-web-app` over `@deepseek-ai/dsh-base`, an `agent-presets` row defaulting to `standard`, and this row as a flat top-level row of the profile tree. The e2e pins the consequence rather than the dump: a scope-free catalog view answers with the shipped skill, while the same agent's scoped view answers with the user's file.

**`skill-badge` is not enabled in this service line.** `packages/bundle/base/cordis.patch.yml` ships it `disabled: true`, no overlay re-enables it, and the dump confirms it stays off. It would coexist harmlessly if enabled: a different provider name at the same rank.

## Alternatives considered

**A plugin that registers its own provider in `apply()`.** `skill-badge` is the working precedent, and it resolves its asset with `import.meta.url` — no `!!js` at all. It registers one fixed skill, though. Supporting a directory of them means re-writing `skill-filesystem`'s discovery, frontmatter parsing, and watching inside the fork: a third surface, a clone-detection hit, and per-file coverage for code that already exists upstream.

**`ctx.skills.register()` for runtime skills.** Rejected outright: runtime registrations rank 250, ahead of the user's own 300/400/500 roots, so a user could not replace shipped knowledge with a same-named skill. That inverts the ruling this whole decision rests on.

**`customSkillDirs` instead of `bundledSkillDir`.** Same inversion by a different route — rank 300 beats `$DSH_HOME/skills`'s 400 — plus the reads would pass through `ctx.fs`, where a stricter filesystem backend can hide the package directory and only warn.

**`DSH_BUNDLED_SKILL_DIR`, the environment root.** Zero repository files, but the knowledge stops travelling with the package: an upgrade delivers no new content, a rollback delivers no old content, one variable cannot serve the desktop and service lines at once, and no gate can show that skills and code are a matched set.

**A `!!js process.env.DSH_LIBRARY_SKILL_ROOT` path.** The prepared fallback, identical in form to `content-column.patch.yml`'s application root. Measurement made it unnecessary, and it would have re-attached the path to the deployment after the package name had already detached it.

**A user-maintained shared skill root, with a promotion path from personal to shared.** The earlier proposal. The product owner declined it for v1: shipped knowledge must not live in a directory anyone can write, because one file there becomes an instruction in every deployment's model context.

## Consequences

The knowledge is versioned, rollback-able, and auditable with the code, and it costs zero TypeScript and zero upstream change. What it costs: editing one sentence is a package release and a redeploy, an already-open session is not promised the new catalog, and the package pays the repository's fixed per-package tax — bilingual README, pairing record, version alignment, `hygiene`.

The coupling audit gains one line: **vendor class names are legal inside `packages/experimental/library-skills/skills/`, and nowhere else.** A shipped skill body will name a component library's classes freely — that is the content's whole job, it is loaded on demand rather than resident, and a user can replace it. The `description` is the exception, because it stays in every request of the session: naming the library there is necessary so the model can decide whether to load, but a list of class names does not belong in it. `packages/experimental/content-frame/src/**` must still match zero vendor class names; this package holds no code and enters no code audit.

The shipped skill today is `library-skills-placeholder`, whose body says only that the wiring works. Real library knowledge replaces it in the next slice, written by an agent and reviewed by a person against the de-identification standard before it enters the package.

## Testing

`apps/web/tests/library-skills.e2e.ts` is keyless, browser-free, and needs no recording: it composes the row over the real Web profile, mounts a preset-composed agent, and reads `ctx.skills` — the same view `dsh-tool-skill` renders its catalog message and `skill` tool result from. It pins that the shipped skill is listed with `provider: library-skills`, `source: bundled`, and `{ modelInvocable: true, userInvocable: false }`, that its body and metadata load by name, that a user skill written into `$DSH_HOME/skills` replaces it in the agent's view while the global layer still answers with the shipped file, and that a composition without the row carries no such skill. Two more cases carry no scaffold: one pins the five composition files to a single identical row, and one evaluates the shipped `bundledSkillDir` expression against a linked and an unlinked profile directory.

That last case runs the expression in a child process, because the missing-package failure cannot happen inside the test process at all: vitest exports pnpm's flat store directory on `NODE_PATH`, which puts every workspace package on `Module.globalPaths` and makes the expression resolve from any directory whatsoever. The same reason rules out asserting the failure through the scaffold. Two further facts shape the case: the web scaffold's settle check is `assertEntriesLoaded`, which rejects only entries with no fiber, so a row whose config throws comes up failed and the scaffold carries on; `boot()` runs `assertEntriesActivated`, which is what makes this fatal in a deployment. The child process reads the expression out of the shipped patch rather than restating it, so rewriting it into something that swallows the miss reddens the case.

The scenario owns no corpus entry. `snapshots/web/*` scenarios are recorded sessions with goldens; every claim here is about the catalog a session starts from, which needs no model turn.
