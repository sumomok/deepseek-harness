# Agent Note: Bounded historical patch identities preserve existing commit history

Status: implemented

English | [中文](2026-11-13-bounded-historical-patch-identities.zh.md)

## Problem

Three existing first-parent commits lack the `Patch:` trailer required by [patch identity](2026-09-17-core-patch-identity-trailers.md). They contain account-detail retry, generated config-catalog reconciliation, and account-platform read sharing. Their patch families are known, but appending a later commit cannot change their messages. Rewriting them would replace descendant commit identities and conflict with the [merge-only patch line](2026-09-24-merge-based-core-patch-line.md).

## Decision

The [historical identity manifest](../../../../.claude/core-patches-history.json) supplies the missing slug for those exact commits. Its version-1 schema permits one to three entries and a fixed pre-integration cutoff. Entries contain a full lowercase commit SHA, exact subject, registered patch slug and nonempty reason. Unknown fields, duplicate keys or commit entries, abbreviated identifiers and malformed values fail parsing. The manifest is maintained explicitly; checks never add entries or advance its cutoff.

On the declared patch line, the cutoff must be a real commit on HEAD's first-parent chain. Every entry must identify a non-merge commit strictly before that cutoff on its first-parent chain. Its actual subject must match, its slug must be registered under any status, and Git must report no `Patch:` trailer at all. An existing empty, malformed, duplicate or conflicting trailer cannot be replaced by a manifest entry. Retiring a patch's code does not erase its historical identity.

Only validated entries supply identities to missing-trailer commits in the current first-parent comparison. Other historical and future commits require their ordinary trailers. Entries remain valid when a later base excludes them from the current comparison, provided the cutoff and their historical relationships still hold. Path ownership and exact merge-parent checks remain independent and unchanged.

The manifest may be absent in a checkout without historical assignments; missing ordinary trailers then fail normally. Other read failures or malformed manifests fail before branch-based skipping. The repository-reference check uses the same parser and exempts only the manifest's `cutoff` and `entries[].commit` JSON string tokens at their syntactic locations. Hashes in reasons, subjects, unrelated files or invalid manifests remain checked.

This decision partially supplements the trailer requirement. The existing identity and merge-line notes remain active because they still own slug identity, ordinary trailers, merge acceptance and path claims.

## Alternatives considered

**Rewrite the three commits and their descendants.** This could insert trailers into the original messages, but would replace existing history and require coordination with downstream branches. The manifest preserves commit identities and records the missing ownership explicitly.

**Ignore all commits before a date or ancestor.** A range exception would hide other missing or malformed identities. The cutoff limits eligibility; only individually listed full commit IDs receive an assignment.

**Exempt the manifest file from reference checking.** This would also allow arbitrary historical hashes in its explanation fields. Parsed token locations retain the reference rule for every field that does not drive Git validation.

## Consequences

The patch checker can accept the three accounted-for omissions while continuing to reject missing trailers elsewhere. This is a bounded maintenance record, not a general alternative to commit trailers. Enlarging or moving the manifest is a policy change requiring explicit review; normal development never uses it for new work.

Tests exercise real temporary Git histories for valid assignments and invalid cutoff, ancestry, parent count, subject, slug and trailer cases. Parser and reference tests cover duplicate keys, invalid schemas and identical hash text outside the operational fields. The manifest does not change the explicit-base rule for later unreleased upstream merges.
