# Agent Note: Core patch identity is a slug in a commit trailer, not a commit hash

Status: implemented

English | [中文](2026-09-17-core-patch-identity-trailers.zh.md)

## Problem

This fork keeps a line of patches over upstream source, registered in `.claude/core-patches.md`. Until now each record identified its patch by commit hash: the heading carried one, and the per-round sections carried the hashes of every commit replayed, retired or adapted that round.

Hashes cannot survive that line's own maintenance. Every rolling sync rebases the whole line onto a new upstream base, which rewrites all of its commits, so every hash a record names is replaced the moment the record's patch moves. Measured on the last round's registry: of the 284 hashes it named, 72 resolved to commits on the line it described; the rest named commits on retired branches, on earlier lines, or upstream. A reader of the registry could not tell which was which.

Upstream then closed the remaining door. `scripts/verify-repository-references.ts` rejects, in every maintained tracked file, any hexadecimal run that resolves to a commit object in this repository, with the message "use release tags or maintained repository links". The registry alone accounted for 267 flagged lines, and four fork Agent Notes plus one source comment accounted for the rest. Patching that gate to exclude `.claude/` was considered and rejected — see below.

## Decision

**A patch family is identified by a kebab-case slug, unique across the line and derived from the patch title.** Every commit on the line carries exactly one `Patch: <slug>` trailer. The registry is organized by slug: one `## <slug> — <title>` section per family, holding the five elements it always held — what changed, why, the intended effect, the retirement condition, and the status with the line it stands on.

A trailer survives a rebase because it is commit message text, and `git rebase` carries messages through unchanged. `git log --format=%(trailers:key=Patch,valueonly)` over the range the registry declares therefore lists the line's families after any rebase, once that declaration names the merge the line now sits on.

**References to history are written the way upstream's gate asks.** A fork change is named by its slug, or by a relative link to its Agent Note. An upstream change is named by its pull-request number or by a release tag.

**`scripts/verify-core-patches.ts` checks the two sides against each other.** For every commit above the declared base merge: exactly one `Patch:` trailer, whose value is a slug the registry registers. For every registry record whose status is `在役` or `局部退役`: at least one commit on the line naming it. Both directions run together, so a renamed slug fails on both sides rather than silently splitting one family into two records. The gate is registered in `doc-sync`. The line's base is the registry's second declaration, `**基座合并**：#<number>`, resolved as the one merge commit in HEAD's own history whose subject opens `Merge pull request #<number> `; no remote-tracking ref takes part. On a shallow clone, whose truncated history cannot reach that merge, the gate prints `skipped` and exits 0 rather than guessing a base.

## Alternatives considered

**Add `.claude/` to the reference gate's excluded prefixes.** One line, and the registry keeps hashes. Rejected: it preserves an identity that the line's own rebase destroys every round, and the measurement above is what that costs — three quarters of the registry's hashes already named nothing on the line. The gate would also stay patched forever, since the fork would have a standing reason to keep the exclusion.

**Keep hashes and re-resolve them after each rebase.** A script could map old hash to new hash through `git range-diff` and rewrite the registry. Rejected: it adds a rewriting step to every sync whose failure mode is silent (a mapping miss leaves a stale hash that still resolves, to the wrong commit), and it does not answer upstream's gate, which rejects the hashes regardless of whether they are current.

**Identify patches by branch name.** The fork already names branches per feature. Rejected: branches are deleted after they land, and one family's commits arrive across several branches over several rounds.

## Consequences

Patch identity now survives the operation that defines this line's maintenance, and a mismatch between the line and its registry is a gate failure rather than something a reader must notice. `git log --grep` over the trailer answers "which commits belong to this patch" on any base.

The cost is that the registry no longer records which commit made which change. That fact was already unavailable in practice — it expired at the next rebase — and where a specific change needs naming, the patch's Agent Note names it in prose.

Every commit on the line must carry the trailer, including one-line documentation fixes; the gate rejects a commit without one. Adding a family means adding its record before its first commit lands, or the gate fails on the unregistered slug.

## Revised after review

**The gate had four ways of passing a real error, all closed.** Its range was `upstream/master..HEAD` on whatever branch it found, while it runs inside `doc-sync`: measured against the same ref, `upstream/master..origin/develop` is 631 commits, 57 of them merges, none carrying a trailer and none meant to, so the first sync that landed this line would have turned `doc-sync` red everywhere else. It now reads the line the registry declares, compares it to the checked-out branch, and reports `skipped` on any other. Its `upstream/master` check verified the ref existed, not that it was this line's base, so a stale ref silently widened the range and reported upstream's own commits as trailer violations; comparing it against `git merge-base` was the wrong repair, replaced below. Its hand-written trailer scan read every line of the message, which accepted a `Patch:` line outside the last paragraph that `git interpret-trailers` cannot see, rejected a lower-case key that git reads, and counted a quoted example line at the start of a line as a second trailer — the shape a commit documenting this very convention takes; git reads the trailers now. And a heading that did not match the record format was ignored rather than reported, so one hyphen in place of an em dash erased a record together with the check that its patch is still on the line.

Two checks were missing rather than broken. A slug the registry retires while its commits remain on the line — the registry claiming a patch is gone while the code disagrees — produced no finding; it does now. So did a merge commit, which now gets a finding that says the line stays linear.

**The base cannot be inferred from `upstream/master`.** A second review measured what that inference does. Ahead of the line — where every `git fetch upstream` leaves it, and where it sat 666 upstream commits past the previous round's base — the gate failed although the range git read was exactly right, so the next fetch would have turned `doc-sync` and `test:docs` red on this line, with `fetch` offered as one of the two remedies. Behind the real base, `upstream/master` is still HEAD's merge base, so the base test accepted it, the range widened over upstream's own commits, and the gate reported those commits as `trailer-count` and `merge-commit` violations and failed — the symptom the paragraph above describes, moved from the base test to the findings list rather than closed. The base is now the registry declaration, resolved in HEAD's own history, and no remote-tracking ref is read at all. Four ways of misreading the registry went with it: a fenced example of the declaration format replaced the line the gate ran against and made it report `skipped` and exit 0; CRLF input erased every record and produced no finding; a repeated declaration silently meant the first one; and a trailer value git accepts but the slug format rejects — git takes any value, folded across lines included — passed as a slug and broke one finding across two report lines.

**The gate has no teeth in CI, by construction.** It no longer needs an upstream remote, but `ci.yml` runs on `pull_request`, where `actions/checkout` leaves a detached HEAD, and `ci-master.yml` runs on `master`: both reach the branch skip on their own triggers. `ci-master.yml` also accepts `workflow_dispatch`, and a manual run on the patch line checks out that branch at full depth, where the gate does compare. Missing trailers, missing registrations and renamed slugs are caught by whoever runs `doc-sync` on the patch line, or not at all. The release tag is not an acceptable substitute base: it is an ancestor of `upstream/master`, not `upstream/master`, so using it would report upstream's own commits as violations of this line. The registry's identity rules state this consequence.

**The registry rewrite dropped more than hashes.** It also removed eight chapters, 414 lines — seven rolling-sync rounds and one record of stable test failures — which the commit message did not say. Most of that was per-commit history the next rebase invalidates. Some of it had no second home anywhere in the repository: three base-environment-sensitive stable reds with the decision not to fix them, two pre-port risk audits, the conflict-resolution rules each round follows, four known blind spots in the three-way audit script, and the cold-read pre-audit procedure. Those are restored as the registry's `历史轮次` section, per-round commit lists deliberately not.
