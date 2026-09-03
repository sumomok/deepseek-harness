# Agent Note: Rolling sync #4 — the fork's patch line onto 0.1.2-rc.1

Status: implemented

English | [中文](2026-09-03-rolling-sync-4-rc1.zh.md)

## Problem

The fork keeps its upstream patches on a rolling `core-patches-vN` line that is rebased onto a fresh `upstream/master` every sync, so each patch is re-proved against the base it will actually ship on. The fourth rolling sync had to move that line from 0.1.2-alpha.5 (`49a606bc5b`) to 0.1.2-rc.1 (`76fda72979`), 63 upstream commits away. Three of those commits carried real collision risk for a fork line: a new `packages/util/http-proxy` library routing every outbound request through the configured proxy, model-listing discovery reaching into `packages/client/ui-settings-models`, and a same-session message-editing feature that upstream merged and then reverted — a pair that would silently add and remove `SessionEventMap` members if the revert were partial. A partial revert or a bumped `SESSION_FORMAT_VERSION` would break every session log the shipped desktop has already written.

## Decision

The line moved as `core-patches-v6` (`git rebase --onto upstream/master 49a606bc5b`), one commit per patch, no squashing, and the fork's retirement clause applied per conflict. All 65 patches replayed with a single conflicting commit and no drop, retirement, or reduction: the two changed file sets intersect in only 13 paths, every one of them a manifest or a generated catalog, so no patch's substantive source file was touched upstream and no retirement clause fired. The one conflict (`0d6f579a96`, spill oversized file attachments) was three dependency-list unions, each resolved as the smallest delta on top of upstream's own form — upstream's out-of-order `http-proxy` append kept where upstream put it, and upstream's reordering of `python/sdk-runtime` dependencies preserved rather than reverted.

One adaptation commit was needed and is mechanical: the fork's only own workspace package, `packages/attachment/attachment-spill`, stayed at the previous base's version while upstream's release moved the root to `0.1.2-rc.1`, which `check-workspace-constraints` rejects. This red recurs on every base version bump and is not a rebase defect.

The three risky upstream changes were each checked directly rather than assumed benign. Nothing on the patch line builds its own fetch or reads a proxy variable, so the new `http-proxy` library needs no adaptation; the line owns zero files under `ui-settings-models`; `SESSION_FORMAT_VERSION` is still `0` on both bases and on the rebased tree; and the editing feature and its revert cancel exactly — `git diff ef88756f13^ e974a655a0` is empty — so the net `SessionEventMap` change is zero.

## Alternatives considered

- **Trust the gate suite to catch a broken session reader.** Rejected: the unit suite reads logs it wrote itself in the same process, so it cannot observe a build refusing a log an older shipped build produced. The sync instead reads a real log written by the shipped rc.28 desktop — 607 events, contiguous `seq`, a legacy `agentPreset: "code"` header — from a read-only scratch copy, and separately proves the refusal path still fires on a forged newer-format header, so the pass is not the absence of any check.
- **Treat the full-suite reds as a rebase regression and chase them.** Rejected on evidence: the four failing files are byte-identical to `upstream/master` on this line, and a pristine `upstream/master` worktree reproduces three of them at identical counts (238 + 6 + 1 = 245 against this line's 246). The remaining one passes in isolation on both trees, so it is parallel-load jitter, already registered in the ledger.
- **Squash the line into one patch per sync.** Rejected: per-patch commits are what make the retirement clause auditable — a patch that upstream has absorbed must be droppable on its own, and a squashed line cannot show which patch died.

## Consequences

- `core-patches-v6` carries 66 commits on `76fda72979`; `master` was fast-forwarded to the same commit and pushed to `origin`.
- The ledger header now names the current line and its base, so the next sync starts from a stated pointer rather than from branch archaeology.
- The four base-environment reds stay registered rather than fixed: this host's `/usr/bin/python3` is CPython 3.9.6 against a 3.10 floor, and one spill test asserts an mtime boundary this filesystem cannot represent. Both need a different host, not a code change.
