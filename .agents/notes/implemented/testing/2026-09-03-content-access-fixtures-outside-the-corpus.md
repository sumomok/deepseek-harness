# Agent Note: The two content-access Web fixtures stay outside the recorded-session corpus

Status: implemented

English | [中文](2026-09-03-content-access-fixtures-outside-the-corpus.zh.md)

## Problem

The content eyes-and-hands line was branched before upstream 0.1.2-alpha.5, and its two Web scenarios — `content-read` and `content-act` — recorded their session fixtures beside their specs, under `apps/web/tests/snapshots/<scenario>/session.jsonl`, because that is where every Web session fixture lived then.

The baseline this line has now merged onto moved the recorded-session corpus to a repository-root `snapshots/{acp,sdk,session,web}/` tree. [`scripts/session-snapshot-corpus.corpus.ts`](../../../../scripts/session-snapshot-corpus.corpus.ts) enumerates it and requires of every directory under it a `snapshot.yml` naming the scenario, its profile, the `composition` it was recorded against, whether the recording is `live` or `authored`, and a `header` block — plus the ownership rules that decide which scenario owns a `session.jsonl` and which borrows one. What survives under `apps/web/tests/snapshots/` is the `*.expected.md` interaction snapshots, which the corpus does not police.

## Decision

The two fixtures stay where they are. Only the seed both scenarios borrow moves, to `snapshots/web/fresh-round-trip/session.jsonl`, because the file itself moved.

Bringing them into the corpus is authoring two manifests and whatever pins the corpus then demands of them — `system-prompt.expected.md` and `tool-schemas.expected.json` for a pinned header, a declared composition, a workspace expectation for a scenario that mutates one. That is snapshot-harness work with its own acceptance, and doing it inside a merge-forward would land it with no evidence that the pins describe this line's composition rather than the day's.

## Consequences

Both scenarios replay keyless against the built app and are green. What they do not get is what the corpus gives its members: no manifest states the composition they were recorded against, so a composition drift is caught only by the assertions the specs write themselves; `assertReplaySession`'s persisted-log comparison stays off, because [`apps/web/tests/scaffold.ts`](../../../../apps/web/tests/scaffold.ts) turns it on from a sibling `snapshot.yml` and there is none; and `pnpm run test:snapshot` does not see them at all, so a change to the model-facing read or step report is caught by these two specs and by nothing repository-wide.

Re-recording them still needs a key and `DSH_SNAPSHOT=record`, and `recordFixture`'s `afterSeed` trim — the reason this line touched the harvest at all — keeps working from either location.

## Alternatives considered

**Move the fixtures and author minimal manifests in this merge.** A manifest whose `composition` and `header` were written to satisfy the enumerator rather than measured against a recording is a pin that pins nothing, and the corpus would then report two scenarios as covered that no recording backs.

**Delete the fixtures and re-record into the corpus.** Recording needs a live key, which a merge-forward has no business requiring; and a re-recorded pair would land with its own model choices, which is a change to what these scenarios assert rather than a move.
