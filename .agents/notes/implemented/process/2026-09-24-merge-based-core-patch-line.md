# Agent Note: The core patch line merges upstream releases and claims its diff against the base tag

Status: implemented

English | [中文](2026-09-24-merge-based-core-patch-line.zh.md)

## Problem

The [slug-and-trailer identity](2026-09-17-core-patch-identity-trailers.md) was built for a line that is rebased onto each new upstream base. `scripts/verify-core-patches.ts` read the base from the registry's `**基座合并**：#<number>` declaration, enumerated every commit in `<base>..HEAD`, and required the range to be linear with exactly one `Patch:` trailer per commit.

The fork now keeps the line as a long-lived branch, `feature/core-patches`, and brings upstream in with `git merge`. The line was continued from `core-patches-v11` through an `-s ours` merge of the tag `core-patches-z`, which joins `core-patches-v9` and the old `core-patches` line so that `develop` and the patch line share one merge base. A probe of the planned history measured what the old gate does with it. With the declaration left at #4469, `<base>..HEAD` held 1725 commits, 453 of them merges. With the declaration moved to the upstream release, the range still held 264 commits and 3 merges, about 130 of them from the joined history, none carrying a trailer. Adding `--first-parent` left 134 commits: the 131 patch commits and three commits of the new history, two of which — the `-s ours` join and the release merge — are merges that the linear rule rejects.

## Decision

**The line is merged, never rebased.** Upstream release tags enter `feature/core-patches` through `git merge`; `core-patches` is only fast-forwarded to it, and `develop` takes core changes only by merging `core-patches`. The registry, `.claude/core-patches.md`, declares `**当前补丁线**：\`feature/core-patches\`` and `**基座 tag**：\`<tag>\`` in place of the base-merge number.

**The gate compares the line's diff, not its commit list, with the registry.** The base is `refs/tags/<tag>^{commit}`, and `git merge-base HEAD <tag>` must equal it (`base-tag-missing` names `git fetch upstream --tags`; `base-tag-not-merged` otherwise). The change set is `git diff --no-renames --name-only <base> HEAD` minus a fixed list of generator outputs. Every `在役` or `局部退役` record carries a `- **路径**：` line of backquoted pathspecs, matched with `:(glob)` magic:

- `unclaimed-path`: a changed path no standing record claims.
- `unused-active-slug`: a standing record that claims no changed path; its change is gone, so it is retired.
- `unused-pathspec`: a pathspec that matches no changed path.
- `missing-paths`: a standing record without a 路径 line.
- `retired-record-claims-paths`: a `退役` record with a 路径 line; a retired family owns no change, and anything it left behind surfaces as unclaimed.

Retirement is therefore the family's change leaving the diff. Its old commits may stay on the line, and the former `retired-slug-in-use` check is gone.

**Commits are read along the first-parent chain.** Every non-merge commit on `git log --first-parent <base>..HEAD` carries exactly one `Patch:` trailer whose value is a slug registered under any status (`trailer-count`, `malformed-trailer`, `unregistered-slug`). The joined history and upstream's commits sit under merges' second parents and are not enumerated.

**Two kinds of merge are accepted on that chain.** (a) The second parent is exactly the commit a `refs/tags/dsh-v*` tag points at, annotated tags dereferenced: an upstream release merge. (b) The merge's tree equals its first parent's tree: an `-s ours` join. Any other merge is `merge-commit`, because a topic merge hides untrailed commits under its second parent; changes to the line land as direct or squashed commits. Rule (a) asks nothing about the declared tag, since every earlier round's release merge stays on the first-parent chain after the declaration moves to a newer tag that cannot reach it.

The gate's scope is unchanged: another branch, a detached HEAD and a shallow clone report `skipped` and exit 0. `develop`, `core-patches` and CI's pull-request checkout therefore skip, even though they carry fork-owned paths and untrailed commits.

## Alternatives considered

**Keep rebasing and join the old lines only on `develop`.** The linear gate would keep passing, but every round would again replace every commit on the line, and `develop` would take each rebased line as a new, unrelated history whose merge base with the previous one is a virtual merge of crossing ancestors.

**Stop declaring `feature/core-patches` as the patch line.** The gate would skip everywhere and the registry would lose its only mechanical check.

**Accept a release merge when the declared tag is an ancestor of, or equal to, its second parent.** A topic branch cut from the line after the tag is merged also has the tag as an ancestor, so the untrailed commits under it would pass. Any ancestry condition also fails the next round: after the declaration moves to a newer tag, this round's release merge stays in range with a second parent older than that tag.

**Enumerate commits and ignore paths.** A trailer shows which family a commit claims, not whether that family still changes anything. The diff is what a rolling sync has to carry forward, so the diff is what each record accounts for.

## Consequences

The registry names the exact paths each family holds against upstream, and a sync that retires a family or leaves a stray change fails the gate until the registry says so. Between merging a newer release and moving the `基座 tag` declaration, the whole upstream span reads as unclaimed; the declaration and the claims move in one registry commit after the merge.

The generated set is a constant in the gate. A generator that starts writing a file the families used to claim by hand, such as a translated catalog, needs that file added to the constant in the same round.

Pathspec matching costs one `git diff` per pathspec, a few milliseconds each over a few hundred pathspecs. The check still has no teeth in CI; it runs where someone runs `doc-sync` on `feature/core-patches`.
