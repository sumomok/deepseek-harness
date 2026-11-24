# Agent Note: Retain an exact historical upstream merge when the base advances

Status: implemented

English | [中文](2026-11-16-bounded-historical-upstream-merges.zh.md)

## Problem

The [merge-based patch line](2026-09-24-merge-based-core-patch-line.md) accepts an unreleased upstream merge only when its second parent equals the currently declared base commit. Advancing that base leaves the previously accepted merge on the first-parent chain, where it no longer matches the declaration or a release tag. Rewriting the merge would replace established history; treating every ancestor of the new base as an upstream release would also accept unlisted merges.

## Decision

The [historical upstream merge manifest](../../../../.claude/core-patches-upstream-merges.json) records prior approvals separately from [missing-trailer identities](2026-11-13-bounded-historical-patch-identities.md). Its version-1 schema requires a cutoff and one to two unique entries, each containing the full lowercase merge commit, its exact first and upstream parents, and a nonempty reason. The commit identity binds the subject and tree as well, so the manifest needs no subject field. Unknown fields, duplicate decoded keys, duplicate commit identities, malformed identities and entries past the bound fail parsing.

On the declared patch line, the cutoff must be a real commit on HEAD's first-parent chain. The approved merge must lie strictly before it on that chain and have exactly the two recorded parents. Its upstream parent must be an ancestor of the current declared base. These checks run even when the approved merge has left the current comparison range. Only the listed full merge identity receives the exception; ancestry alone approves nothing. The checker never adds approvals or advances the cutoff.

This decision partially supersedes the earlier rule that every historical unreleased merge needs a real release tag after the base advances. Release merges, exact current-base merges, unchanged-tree joins, ordinary trailers and path claims keep their existing rules. The identity and merge-line notes remain active because they own those independent constraints; the fixed missing-trailer manifest is unchanged.

An absent manifest grants no exception. A malformed or unreadable manifest fails before branch-based skipping. The repository-reference checker uses the same strict parser and exempts only the cutoff and the entry's commit, first-parent and upstream identity string tokens. Reasons, other files and invalid manifests remain checked, including Unicode-escaped text.

## Alternatives considered

**Accept any merge whose second parent is an ancestor of the base.** This would authorize every unlisted ancestor, rather than retain only the explicitly approved prior merges. The first-parent cutoff limits eligibility but does not itself grant approval.

**Invent a release tag, rewrite the prior merge, or replace it with an unchanged-tree join.** These choices would misstate the upstream release identity or change established history instead of recording the exact previously accepted merge.

**Reuse the missing-trailer manifest.** It supplies a slug only to existing non-merge commits with no trailer. A merge approval changes a different rule and therefore has its own schema, parser and Git validation.

**Exempt the whole manifest from repository-reference checks.** A file exemption would also hide hashes and organization URLs in its rationale. Exact syntactic token exemptions preserve those checks.

## Consequences

A base advance retains the explicitly approved historical merges without permitting later topic merges, other upstream ancestors or octopus merges. Enlarging the bounded schema or moving the cutoff is a separate policy change requiring review. Tests use temporary Git repositories to exercise the valid advance, unlisted ancestors, topic merges, wrong parents, cutoff violations and an octopus; parser and reference tests cover malformed, duplicate and escaped inputs. No active note is fully superseded by this exception, so the existing identity, historical-identity and merge-line triplets stay active.
