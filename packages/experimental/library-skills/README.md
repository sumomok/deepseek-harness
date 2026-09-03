---
description: "Ship component-library conventions as bundled SKILLs that travel with a package version and stay overridable by a user's own same-named skill."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-library-skills

English | [中文](README.zh.md)

## Summary

`dsh-experimental-library-skills` carries reusable component-library knowledge — how a widget library's markup reads, what its icon and control conventions mean — as SKILL files that ship inside the package. Its patch mounts one isolated `skill-filesystem` provider over the package's own `skills/` directory at the lowest skill rank, so the model finds this knowledge in its catalog while any same-named skill a user writes replaces it. The knowledge travels with the package version: changing a sentence means publishing a version, and rolling the package back rolls the knowledge back with it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

From this repository checkout, add the package to an initialized profile:

```sh
pnpm dsh plugin --profile web add ./packages/experimental/library-skills
```

The profile must already contain `@deepseek-ai/dsh-base`, which supplies the `skill` registry this row registers into. Removing the package with `dsh plugin --profile web remove @deepseek-ai/dsh-experimental-library-skills` removes the bundle from the profile's ordered layer list, and the skills it carries leave the catalog with it.

### What you get

Every skill under `skills/` appears in the agent's skill catalog under the provider name `library-skills`, and the model loads a body with the `skill` tool. A skill of the same name under `$DSH_HOME/skills`, `.dsh/skills`, or `.agents/skills` wins over the shipped one.

### Add a skill

Create `skills/<name>/SKILL.md`. The frontmatter carries the fields the provider parses:

```yaml
---
name: <kebab-case>
description: <the condition under which the model should load this skill>
user-invocable: false
metadata:
  source: <ruminate|exploration>
  library: <component library>
  libraryVersion: <version or range>
  fromSessions: [<sessionId>, …]
---
```

`name` and `description` are both required and a file missing either is skipped with a log warning rather than a load failure, so a new skill needs a test that asserts its name reaches the catalog. `description` is the only text that stays resident in the model's context, so write the trigger condition there and keep the body for the knowledge itself. `metadata` reaches no model surface; it records where the knowledge came from and which library version it was written against.

Two invocation rules hold for every skill in this package. Never write `disable-model-invocation`: it removes the skill from the model-facing catalog, which is the only place library knowledge is useful. Always write `user-invocable: false`: bundled library knowledge is written for the model, and the key defaults to true, so a skill without it becomes a `/`-menu entry in whatever console composes this package — maintainer vocabulary on an end user's command list.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml) and the `skills/` directory it mounts. The patch inserts one `@deepseek-ai/dsh-skill-filesystem` row with `providerName: library-skills`, `includeDefaultRoots: false`, and `bundledSkillDir` resolved from the package name, so the provider contributes this one directory and no project, user, or environment root.

`bundledSkillDir` mounts its root at `BUNDLED_SKILL_RANK` (600), below the project (100), custom (300), and user (400/500) roots. Two independent mechanisms therefore keep a user's same-named skill ahead of a shipped one: the registry merges the global layer first and lets each nearer scope layer replace it, and rank decides duplicates inside a single layer. A bundled root also reads through Node directly rather than through `ctx.fs`, so a deployment's filesystem policy cannot hide the shipped skills.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The one composition row: an isolated `skill-filesystem` provider over `skills/` |
| `skills/<name>/SKILL.md` | One bundled skill; only this two-level layout is discovered |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch and the skill files are the runtime content |
| — | No runtime invariant companion is published; the package owns no mutable relationship. The `skill` registry owns catalog merging and the `skill-filesystem` provider owns discovery. |

The `bundledSkillDir` expression resolves this package by name from the profile the layer is installed into:

```js
process.getBuiltinModule('node:path').resolve(
  process.getBuiltinModule('node:module').createRequire(baseUrl)
    .resolve('@deepseek-ai/dsh-experimental-library-skills/package.json'),
  '../skills',
)
```

`baseUrl` is the profile directory, and `createRequire` searches that directory's `node_modules` and its ancestors — the two places a profile install puts the package. The two failure modes differ. A profile that cannot resolve the package throws `MODULE_NOT_FOUND` while the row loads, and the boot fails; the row makes this package a deployment dependency of every composition that carries it. A resolvable package whose `skills/` is missing or empty fails quietly instead: `listSkillRootEntriesFromNode` treats an absent directory as no entries, so the root mounts and lists nothing. Two things gate that second mode — `apps/web/tests/library-skills.e2e.ts`'s listing case fails on an empty directory, and the `packageFileExtras` entry in `scripts/check-workspace-constraints.ts` forces `skills` into the published `files` list.

Files below `skills/<name>/` are not skills — the provider discovers only `<root>/<name>/SKILL.md` and `<root>/<name>.md` — but the model can still read them: the loaded skill names its bundle directory as the base for relative paths.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and release exclusion.
- [Skill registry](../../skill/skill/README.md) — layer merging, ranks, and the catalog API.
- [Local skill discovery](../../skill/skill-filesystem/README.md) — roots, frontmatter parsing, and watching.
- [Skill tool](../../skill/tool-skill/README.md) — how the catalog and a loaded body reach the model.

-----

<a id="model-experience"></a>
## Model Experience

### Bundled library knowledge

#### What the model sees

At the start of a session the skill tool publishes one catalog message listing every skill's name and description, this package's included. The body reaches the model only after it calls `skill <name>`, which returns the file's Markdown verbatim inside `<skill_content>` together with the bundle directory as the resource base.

#### Token effect

Each shipped skill adds one catalog line — its name plus a description truncated at 500 characters — to every request in the session. A body enters the context once, in the tool result, when the model loads it.

#### KV Cache effect

The catalog message is prefix-stable while the shipped skill set and the user's own skill roots are unchanged; publishing a new package version changes it, as does a user adding or renaming a skill.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Placeholder content** — the shipped `library-skills-placeholder` skill exists to prove the composition reaches the catalog and carries no component-library knowledge. A real skill replaces it.
- **Model-facing only** — every skill here carries `user-invocable: false`, so none of them appears in a human `/` command menu. A deployment that wants one of these bodies on a user-facing menu writes its own skill of the same name in a user root, where it also wins the catalog.
- **A wording change is a release** — the skills are static package files with no hot update, no per-deployment selection, and no A/B split. Editing one sentence means publishing a package version and redeploying.
- **Already-open sessions** — the catalog is published once per session and updates through the catalog-change path; a running session is not promised the new content on the next turn.
- **No per-user visibility** — a single-process console separates user skill roots by `$DSH_HOME` and by workspace, not by person, so this package makes no promise that one user's skills are invisible to another.
- **Content is authored, not derived** — the shipped knowledge is written by an agent and reviewed by a person for anything that identifies a real record, person, or machine before it enters the package. Nothing in this package enforces that review.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package publishes `skills` through the `packageFileExtras` table in `scripts/check-workspace-constraints.ts`; a new asset directory needs an entry there or it stays out of the tarball.

</details>
