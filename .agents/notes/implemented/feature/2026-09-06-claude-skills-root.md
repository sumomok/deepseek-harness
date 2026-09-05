# Agent Note: The local skill provider reads the `.claude` roots

Status: implemented

English | [中文](2026-09-06-claude-skills-root.zh.md)

## Problem

Skills authored for other agent clients live in `.claude/skills` — one copy in the repository, one under the user's Claude Code configuration root — and most mainstream clients read that directory. `dsh-skill-filesystem` scanned `.dsh/skills` and `.agents/skills` at each tier and nothing else, so a repository that ships its skills in `.claude/skills` and a user whose personal skills live in `~/.claude/skills` both reached a DSH session with an empty catalog, while every other client on the same checkout saw them.

No composition-layer configuration expresses those roots. `customSkillDirs` takes absolute paths resolved once at plugin load; it can name one user directory but never "the `.claude/skills` of whichever project this lookup runs in", because the project root is resolved per `list()` call from the lookup cwd. A second `SkillProvider` could resolve them, but it would carry its own copy of the root scan, the frontmatter grammar, the missing-root probe and Chokidar manager, and would merge into the registry by provider registration order rather than by root rank — two providers watching sibling directories, with the duplicate-name outcome decided by mount order instead of the priority table. The root list is a fixed array inside the upstream provider, so this is a core patch.

## Decision

`dsh-skill-filesystem` scans `<projectRoot>/.claude/skills` at rank 210 as `project-claude`, and `<claudeHome>/skills` at rank 510 as `user-claude`. Both are default roots: `includeDefaultRoots: false` still omits every project and user row, so an isolated custom-root provider gains nothing new. `claudeHome` is a new `Config` field defaulting to `$DSH_CLAUDE_HOME`, then `~/.claude`, resolved exactly as `agentsHome` resolves `$DSH_AGENTS_HOME` then `~/.agents`. The override is this harness's own variable rather than Claude Code's: a root the harness loads instructions from moves only when the harness's own environment says so, which is why the `.agents` root reads `$DSH_AGENTS_HOME` and not some shared convention either. `SkillSource` gains the two matching literals.

Each `.claude` root ranks directly below the `.agents` root of its own tier, inside the spacing the existing constants left free, so a name present in both resolves to the shared `.agents` convention and neither root can outrank the harness's own `.dsh` root or fall past `custom` and the runtime rank. The tie is not hypothetical: this repository's own `.claude/skills` is a symbolic link to `.agents/skills`, so both roots offer every repository skill under the same name and the winner must be fixed rather than incidental.

The watch manager needed no change. It keys watchers by resolved root path and follows a missing root one absent segment at a time from its nearest existing ancestor, with no special case for `.agents` or `skills`, so the two new roots are watched, probed, and bounded by `watchMaxProjects` the way the existing ones are.

`roots()` now returns one root per directory. A link makes two roots the same directory — this repository's `.claude/skills` is one — and the untouched list offers every skill twice: the registry resolves each duplicate to the higher-priority root and warns once per skill, and the watch manager opens two host watchers on the one directory. Each root is resolved through `canonicalizeWatchPath`, the resolver the watcher already applies, and a root whose canonical path an earlier root already covers is dropped before discovery and watching. A root that cannot be canonicalized — an unreadable ancestor, or an ancestor that is a regular file — keeps its configured path as its identity and stays in the scan, which reports the failure with its own diagnostic.

Pinning the roots in tests moved into one function. `isolatedSkillRootEnv(cwd, overrides)` in `dsh-loader-smoke` returns the whole block — `DSH_HOME`, `DSH_AGENTS_HOME`, `DSH_CLAUDE_HOME`, and `DSH_BUNDLED_SKILL_DIR` when a launcher supplies one — and every launcher spreads it: the loader smoke, the snapshot launcher and harness, the SDK snapshot runner, the Web scaffold and its real smokes, five CLI end-to-end suites, and the two release scripts that build a consumer environment. The Python runtime smoke pins the same names inline, having no way to call TypeScript. The bug this replaces was exactly a missed site: `snapshots/sdk/sdk.snapshot.ts` pinned `DSH_AGENTS_HOME` alone, so the first run of this change put a developer's own `~/.claude/skills` into eleven recorded SDK transcripts.

## Alternatives considered

**Point `customSkillDirs` at the directories from a deployment's cordis.yml.** It reaches only absolute paths fixed at load. The user root is expressible that way for one machine; the project root is not expressible at all, and every deployment would carry the same two rows.

**Ship a separate provider package for the `.claude` roots.** It duplicates discovery, parsing, and watching, doubles the host watchers on directories the existing manager already tracks, and moves duplicate-name resolution from the rank table to provider registration order.

**Rank `.claude` above `.agents`.** A compatibility root would then beat the convention the harness documents as its own, and in this repository — where the two are the same directory through a link — the winner would flip for no reason a reader could predict.

**Read Claude Code's own `$CLAUDE_CONFIG_DIR`.** It would follow a relocated Claude Code configuration root without anyone configuring anything. It also lets another tool's environment decide where this harness loads instructions from, and it puts a skill root behind a name outside the `DSH_` prefix that `app-boot` refuses from a discovered `.env`, so a cloned repository could redirect a user skill root by shipping one. `$DSH_CLAUDE_HOME` inherits that refusal and keeps the override symmetric with `$DSH_AGENTS_HOME`; a user who has moved Claude Code's root points `claudeHome` or `$DSH_CLAUDE_HOME` at it.

**Scan `.codex/skills` in the same change.** Undecided, and each root is one more watched directory and one more origin for a name. It stays out until it is asked for.

## Consequences

Every lookup with a cwd now resolves up to five project and user roots instead of three, each costing one canonical-path resolution, and a missing root costs one `fs.watchFile` probe until it appears. Where a `.claude` root links to its `.agents` sibling the deduplication cancels both costs: that root is neither scanned nor watched, and this repository's own checkout sees no second listing, no second watcher, and none of the eleven duplicate-name warnings the untouched list produced.

A launcher that forgets a root is now the only way a host skill reaches a fixture, and there is one place to forget it. Without the pin a developer with `~/.claude/skills` records different transcripts than CI — twice proven here, first by the package tests reading this machine's real skills, then by the SDK snapshots. `apps/web/tests/scaffold-hermetic.e2e.ts` asserts the scaffold hides an ambient `.claude` root the same way it hides the other three.

A released desktop build now reads its end user's `~/.claude/skills` by default. There is no runtime switch: a deployment that does not want it sets `includeDefaultRoots: false` and lists the roots it does want, or points `claudeHome` at a directory it controls.

Package tests cover the new roots in the assembled provider: both `.claude` tiers discovered with their sources, an `.agents` name beating its `.claude` twin at both tiers, `includeDefaultRoots: false` omitting both, `$DSH_CLAUDE_HOME` resolution, the `~/.claude` fallback when it is unset, a linked duplicate root discovered once with no warning, and one host watcher for that linked pair.

Retire when upstream's own `skill-filesystem` scans the `.claude` roots.
