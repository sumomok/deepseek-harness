# Agent Note: The two content-access Web fixtures stay outside the recorded-session corpus

Status: implemented

English | [中文](2026-09-03-content-access-fixtures-outside-the-corpus.zh.md)

## Problem

The content eyes-and-hands line was branched before upstream 0.1.2-alpha.5, and its two Web scenarios — `content-read` and `content-act` — recorded their session fixtures beside their specs, under `apps/web/tests/snapshots/<scenario>/session.jsonl`, because that is where every Web session fixture lived then.

The baseline this line has now merged onto moved the recorded-session corpus to a repository-root `snapshots/{acp,sdk,session,web}/` tree. [`scripts/session-snapshot-corpus.corpus.ts`](../../../../scripts/session-snapshot-corpus.corpus.ts) enumerates it and requires of every directory under it a `snapshot.yml` naming the scenario, its profile, the `composition` it was recorded against, whether the recording is `live` or `authored`, and a `header` block — plus the ownership rules that decide which scenario owns a `session.jsonl` and which borrows one. What survives under `apps/web/tests/snapshots/` is the `*.expected.md` interaction snapshots, which the corpus does not police.

## Decision

The two fixtures stayed where they were. Only the seed both scenarios borrow moved, to `snapshots/web/fresh-round-trip/session.jsonl`, because the file itself moved.

Bringing them into the corpus meant authoring two manifests and whatever pins the corpus then demanded of them — `system-prompt.expected.md` and `tool-schemas.expected.json` for a pinned header, a declared composition, a workspace expectation for a scenario that mutates one. That is snapshot-harness work with its own acceptance, and doing it inside a merge-forward would have landed it with no evidence that the pins described this line's composition rather than the day's.

## Consequences

Both scenarios replay keyless against the built app and are green, and the Web browser snapshot lane runs them: `webSnapshotGate` in [`scripts/run-gates.ts`](../../../../scripts/run-gates.ts) belongs to the `ci-linux-primary` and `ci-consumers` aggregates and to no other, and every path it takes drives [`vitest.web.config.ts`](../../../../vitest.web.config.ts), whose include covers all of `apps/web/tests/**/*.e2e.ts`. `check-all` is not one of those aggregates, so running everything locally says nothing about either scenario. What they gave up for as long as they stayed outside was corpus membership: no manifest stated the composition they had been recorded against, so a composition drift was caught only by the assertions the specs write themselves; `assertReplaySession`'s persisted-log comparison stayed off, because [`apps/web/tests/scaffold.ts`](../../../../apps/web/tests/scaffold.ts) turns it on from a sibling `snapshot.yml` and neither directory held one; and `pnpm run test:snapshot` did not enumerate them.

Neither committed fixture was a fixed point of the typed redaction, which is what made bringing them in a re-recording or a redaction pass rather than a move. Run through the built [`dsh-session-snapshot`](../../../../packages/test-support/session-snapshot/README.md), the corpus's own `snapshots/web/fresh-round-trip/session.jsonl` redacted to itself and those two did not: `content-read` carried eight distinct raw UUIDs and `content-act` eleven, and both wrote the older placeholders `{{sessionId}}` and `{{rpcId}}` where the corpus writes `{{session:1}}`, `{{message:N}}`, and `{{rpc:N}}`.

Re-recording them needed a key and `DSH_SNAPSHOT=record`, and `recordFixture`'s `afterSeed` trim — the reason this line touched the harvest at all — worked from either location. [`docs/testing.md`](../../../../docs/testing.md) requires every Web recording to live under `snapshots/web/`, so the next re-recording of either fixture would put it there with its manifest, ending the deviation.

**That is what happened, and this note is superseded.** [The markup reads](../feature/2026-09-03-content-markup-reads.md) changed the tool schemas both scenarios' requests carry, which made re-recording them necessary. Both are now recorded under `snapshots/web/` with manifests, beside that slice's own two new scenarios, and the deviation is over. Bringing them in also took the change this note said the move would need: a corpus manifest turns on the persisted-log comparison, and these scenarios seed a round into the session they drive, so `assertReplaySession` cuts the live log at the `session/end-seed` boundary `recordFixture`'s `afterSeed` trim already cut the recording at. The decision above describes what was chosen at the merge, not the tree.

## Alternatives considered

**Move the fixtures and author minimal manifests in this merge.** A manifest whose `composition` and `header` were written to satisfy the enumerator rather than measured against a recording is a pin that pins nothing, and the corpus would then report two scenarios as covered that no recording backs.

**Delete the fixtures and re-record into the corpus.** Recording needs a live key, which a merge-forward has no business requiring; and a re-recorded pair would land with its own model choices, which is a change to what these scenarios assert rather than a move.
