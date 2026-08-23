# Agent Note: A desktop release tags its own commit and checks what it built

Status: implemented

English | [中文](2026-08-23-desktop-release-pipeline-hardening.zh.md)

## Problem

Two steps of the desktop release lived outside the scripts that run it, and both failed the same way — silently, in the direction of "looks fine".

**Nothing tagged the released commit.** `desktop-v0.1.0-rc.14` through `desktop-v0.1.0-rc.19` were each created by hand, after the fact, from whatever the repository happened to be on at the time. `apps/desktop/scripts/publish-update.ts` uploads artifacts, rewrites manifests, reads them back and prunes the feed, and then stops: a published build had nothing pointing at the source it came from until someone remembered to type two git commands. Nothing reports a forgotten tag, so the record of what shipped depended on the release runner's memory. The desktop app is `private` and reaches no registry, so none of the repository's release workflows own it either ([private apps](2026-08-20-private-apps-are-not-release-members.md)).

**A packaging run could build half of a release and exit 0.** `parseCli` in `apps/desktop/scripts/package.ts` inferred `--mac` from `process.platform === 'darwin'` when neither platform flag was given, while `--win` was never inferred. A bare `pnpm --filter @deepseek-ai/dsh-desktop run package` on a macOS host therefore built the mac products only. The run then closed by listing `dist-app` filtered to `.dmg`, `.zip`, and `.exe` — and `dist-app` is never cleared, so the previous version's Windows installer was in that listing, at the previous version's name, under the heading `products in apps/desktop/dist-app`. A release with no Windows build printed the same shape of output as a complete one. rc.19 was packaged that way.

## Decision

### Tagging is a step of the publish, decided before the upload and executed after it

A publish tags the commit it shipped: `desktop-v<version>`, where the version is the same `apps/desktop/package.json` field that names the artifacts and the manifests. The tag is annotated and its message is the release-notes file `--notes` already requires, so `git tag -n` shows what shipped. It names `HEAD` of the repository the script runs in.

**The decision is made before the first byte goes up.** `planReleaseTag` in `apps/desktop/scripts/release-tag.ts` takes the version and what git reports — HEAD, the tag's commit here and on `origin`, whether the tree is dirty, whether `origin` exists — and returns `create`, `push-existing`, `skip`, or a refusal carrying the line to print. Three states refuse:

- **A tracked file differs from HEAD.** `git status --porcelain --untracked-files=no` must be empty — the definition `git describe --dirty` uses. A tag on a tree carrying uncommitted changes names a source that does not reproduce the build. Untracked files are excluded deliberately: a release run writes its own logs into the worktree it runs in and an ignored `.env` lives there permanently, and neither reaches the build.
- **The tag already exists, at another commit,** here or on `origin`. Moving it would need a force push, and the release it currently names is a real one.
- **No `origin`.** A tag that cannot be pushed is a tag only one machine has.

Each refusal is one line naming the fix, thrown before the script reads the feed. At that point the artifacts are still local and the correction is a re-run; the same refusal after the upload would be a live release with no tag and no way to add one honestly.

**Execution runs after the publish has fully succeeded** — after both manifests are read back from the feed serving the new version and after the prune, at the very end of `main`. Tagging earlier would leave `desktop-v<version>` naming a release that never reached clients. `git push origin <tag>` is never forced.

**Which side already carries the tag chooses the action, and `origin` is authoritative** because it is the copy every other clone reads. Neither side carries it: create it here and push. Only this repository, at HEAD: push it. Only `origin`, at HEAD: `git fetch origin tag <tag>`, with nothing to push — creating a second annotated object here for a name `origin` already publishes produces a push git rejects, and the tag other clones already have is the one that counts. Both sides, at HEAD: no git runs at all, and the release is reported as tagged. The last two are ordinary rather than exotic: this repository is developed in several worktrees, so a `--republish` from a worktree that did not run the first publish finds the tag on `origin` and absent locally, and the two tag objects can differ — one made by `git tag -a`, one made through the GitHub API — while both peel to the same commit. Every comparison here is against the peeled commit, never the tag object.

**A failure at that late point is reported as what it is.** The log states that the version IS published and that only the tag step failed, prints the exact `git tag -a <tag> -F <notes> && git push origin <tag>` (or just the push, when the tag was created and the push is what failed), and the process exits non-zero. The closing summary line names the tag either way.

`--no-tag` skips the step and its preflight, so a publish from a repository that could not be tagged still runs; `--dry-run` prints what it would tag and pushes nothing. `apps/desktop/tests/release-tag.spec.ts` covers every branch of the decision without a repository.

### A packaging run names its platforms, and proves it produced them

`parseCli` infers nothing. `--mac`, `--win`, or both; neither flag exits non-zero naming the three forms. Each platform costs about fifteen minutes, which is the reason to refuse rather than to default to both.

After the builds, `verifyProducts` computes the files this version owes for the platforms actually requested and requires each one to be present, non-empty, and **written since this run started** — `main` records `startedAt` before anything else, and `auditArtifacts` classifies a file older than that as `stale`. Presence alone is not evidence: repackaging one version after a fix is routine, so the directory usually already holds this version's own artifacts, under exactly the expected names, from the previous run. The failure names every file and why it failed (`(missing)`, `(empty)`, `(stale: built before this run)`); success prints the verified list with sizes. `expectedArtifacts` and `auditArtifacts` in `apps/desktop/scripts/artifact-names.ts` are pure; the script supplies the sizes and modification times.

The expected names are electron-builder's defaults for the targets `apps/desktop/electron-builder.yml` declares, because no `artifactName` overrides them: `DSH Desktop-<version>-arm64-mac.zip` and `DSH Desktop-<version>-arm64.dmg` for the mac targets, `DSH Desktop Setup <version>.exe` for the NSIS target, each with its `.blockmap` — the same pairing `publish-update.ts` requires, since an artifact without a blockmap costs every client a full download. `apps/desktop/tests/artifact-names.spec.ts` reads the config and asserts the `productName`, the per-target arch lists, and the absence of any `artifactName` override, so a config change that renames the products fails a test rather than a release.

Naming is not duplicated: `publish-update.ts` reads the artifact names out of the manifests electron-builder wrote, and `prune-feed.ts` derives its templates from the names a publish uploaded. Both describe files that already exist. `artifact-names.ts` is the only place that states what a build owes before it has produced anything.

## Alternatives considered

**Tag before the upload, when the preflight passes.** This is where the information is, and it is the wrong place to act on it: uploads fail here often enough that the uploader resumes partial transfers as a matter of course. A tag pushed ahead of a publish that then dies names a release nobody can install, and deleting a pushed tag is a worse operation than adding one late. The preflight already captures the cheap half of tagging early — the decision — and leaves only the act for the end.

**Treat a failed tag as a failed publish.** Considered, and it is what the exit code says: the process exits non-zero, so any caller sees a failure. What it must not say is that the release failed, because the artifacts are live and serving. Re-running the publish to "fix the tag" would re-upload some 600 MB and, under `--republish`, overwrite artifacts a live manifest already vouches for. The log therefore states the split state explicitly and hands over the two commands that finish it.

**Let `--no-tag` be the default and tag with a flag.** That is the current situation with extra steps: an opt-in step is the one that gets forgotten, which is what produced six by-hand tags. The flag exists for the case that genuinely cannot tag — a detached checkout, a repository with no `origin` — and states that intent in the command line.

**Default to both platforms when neither flag is given.** A bare invocation would then start a half-hour build on someone's laptop, and cross-building the Windows installer from macOS is a deliberate act with its own verification posture, not a thing to start by accident. Exiting immediately costs one re-run of the command with the flag it was missing.

**Keep inferring the host platform and just fix the listing.** The listing is only half the fault. The inference is invisible in the command line, asymmetric between the two platforms, and produces a build that is complete for the host and silently short for the other — exactly the state that shipped rc.19. A correct listing would have reported it, but the run would still have been started wrong.

**Verify the artifact set against the manifests electron-builder wrote.** `latest.yml` and `latest-mac.yml` land in `dist-app` beside the artifacts and carry the exact names, which looks like a free source of truth. They are also left behind by the previous run: a platform whose build did not execute leaves the last run's manifest in place, so the check would read its expectation from the very output whose absence it is supposed to detect. The expectation has to be independent of what the run produced.

**Count untracked files as a dirty tree.** `git status --porcelain` with no flag is the stricter reading and the wrong one here: the release runs write their own logs into the worktree, and an ignored `.env` sits there permanently. Refusing on those would refuse every publish, and the escape would be `--no-tag` — the flag that turns off the feature this note adds. What the tag has to promise is that the tracked source reproduces the build, which is exactly what `--untracked-files=no` compares, and it is the definition `git describe --dirty` already uses.

**Create the tag here regardless and force what `origin` has.** A single rule would be simpler than four actions. It is also the one operation that can destroy a record: `origin`'s tag is what every other clone and the GitHub release page already show, and replacing it silently rewrites what a shipped version points at. Fetching `origin`'s copy costs one command and leaves the published record untouched.

**Accept an artifact that merely exists at the expected name.** This was the first version of the check and it survives exactly one failure mode — a version never built at all. The one that actually happens is a rebuild of the same version after a fix, where every stale file already carries the expected name. A timestamp is the only thing that separates them without hashing an inventory, and the run already knows when it started.

**Read `productName` and the target archs out of `electron-builder.yml` at run time** instead of holding them as constants pinned by a test. The names still would not follow from the config alone — electron-builder's default `artifactName` templates are not in it — so a runtime read would add YAML parsing and file IO to a pure function while leaving the templates hardcoded anyway. The test reads the config instead, which fails on a config change during `pnpm run test` rather than fifteen minutes into a release build.

## Consequences

Every desktop release from rc.20 on is tagged by the publish that shipped it, with the release notes as the tag message; rc.14 through rc.19 keep the tags that were made by hand.

A publish now depends on git and on reaching `origin`: preflight runs `git ls-remote`, so a publish from a machine that cannot reach the remote fails at preflight rather than at the end. `--no-tag` is the way through. A publish also now requires every tracked file to match HEAD, which is a real constraint on the habit of publishing with an edit in flight; untracked files, including the logs the release runs write themselves, are not counted.

`pnpm --filter @deepseek-ai/dsh-desktop run package` with no flag now fails instead of building the host platform. Every invocation names its platforms.

A packaging run that produces a byte-identical artifact still passes, because electron-builder rewrites the file rather than leaving an untouched one; what the timestamp detects is a target that did not run, not a build whose output did not change.

`apps/desktop/tests/release-tag.spec.ts` pins the refusals (a tracked-file change, a tag elsewhere locally, a tag elsewhere on `origin`, no `origin`), all four success actions, the `--no-tag` skip, and the precedence when several conditions hold at once. `apps/desktop/tests/artifact-names.spec.ts` pins the per-platform name sets against `electron-builder.yml` and the audit's verified, missing, empty, and stale groups, including a whole platform left over from an earlier run of the same version. The git commands themselves have no test — `git tag -a`, `git push origin <tag>`, and the four read-only queries feeding the plan — for the same reason the prune's `rm` has none: they run once per release against a real repository, and their evidence is the release. The publish path has no harness in which a fake origin would prove anything the plan tests do not.
