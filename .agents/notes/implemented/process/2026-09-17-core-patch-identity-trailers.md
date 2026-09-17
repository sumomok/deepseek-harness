# Agent Note: Core patch identity is a slug in a commit trailer, not a commit hash

Status: implemented

English | [中文](2026-09-17-core-patch-identity-trailers.zh.md)

## Problem

This fork keeps a line of patches over upstream source, registered in `.claude/core-patches.md`. Until now each record identified its patch by commit hash: the heading carried one, and the per-round sections carried the hashes of every commit replayed, retired or adapted that round.

Hashes cannot survive that line's own maintenance. Every rolling sync rebases the whole line onto a new upstream base, which rewrites all of its commits, so every hash a record names is replaced the moment the record's patch moves. Measured on the last round's registry: of the 284 hashes it named, 72 resolved to commits on the line it described; the rest named commits on retired branches, on earlier lines, or upstream. A reader of the registry could not tell which was which.

Upstream then closed the remaining door. `scripts/verify-repository-references.ts` rejects, in every maintained tracked file, any hexadecimal run that resolves to a commit object in this repository, with the message "use release tags or maintained repository links". The registry alone accounted for 267 flagged lines, and four fork Agent Notes plus one source comment accounted for the rest. Patching that gate to exclude `.claude/` was considered and rejected — see below.

## Decision

**A patch family is identified by a kebab-case slug, unique across the line and derived from the patch title.** Every commit on the line carries exactly one `Patch: <slug>` trailer. The registry is organized by slug: one `## <slug> — <title>` section per family, holding the five elements it always held — what changed, why, the intended effect, the retirement condition, and the status with the line it stands on.

A trailer survives a rebase because it is commit message text, and `git rebase` carries messages through unchanged. `git log --format=%(trailers:key=Patch,valueonly) upstream/master..HEAD` therefore lists the line's families at any moment, on any base.

**References to history are written the way upstream's gate asks.** A fork change is named by its slug, or by a relative link to its Agent Note. An upstream change is named by its pull-request number or by a release tag.

**`scripts/verify-core-patches.ts` checks the two sides against each other.** For every commit above `upstream/master`: exactly one `Patch:` trailer, and a slug the registry registers. For every registry record whose status is `在役` or `局部退役`: at least one commit on the line naming it. Both directions run together, so a renamed slug fails on both sides rather than silently splitting one family into two records. The gate is registered in `doc-sync`. Without an `upstream/master` ref — a shallow clone, or a checkout with no upstream remote — the line's extent is unknown, so the gate prints `skipped: no upstream/master ref` and exits 0 rather than guessing a base.

## Alternatives considered

**Add `.claude/` to the reference gate's excluded prefixes.** One line, and the registry keeps hashes. Rejected: it preserves an identity that the line's own rebase destroys every round, and the measurement above is what that costs — three quarters of the registry's hashes already named nothing on the line. The gate would also stay patched forever, since the fork would have a standing reason to keep the exclusion.

**Keep hashes and re-resolve them after each rebase.** A script could map old hash to new hash through `git range-diff` and rewrite the registry. Rejected: it adds a rewriting step to every sync whose failure mode is silent (a mapping miss leaves a stale hash that still resolves, to the wrong commit), and it does not answer upstream's gate, which rejects the hashes regardless of whether they are current.

**Identify patches by branch name.** The fork already names branches per feature. Rejected: branches are deleted after they land, and one family's commits arrive across several branches over several rounds.

## Consequences

Patch identity now survives the operation that defines this line's maintenance, and a mismatch between the line and its registry is a gate failure rather than something a reader must notice. `git log --grep` over the trailer answers "which commits belong to this patch" on any base.

The cost is that the registry no longer records which commit made which change. That fact was already unavailable in practice — it expired at the next rebase — and where a specific change needs naming, the patch's Agent Note names it in prose.

Every commit on the line must carry the trailer, including one-line documentation fixes; the gate rejects a commit without one. Adding a family means adding its record before its first commit lands, or the gate fails on the unregistered slug.
