# Agent Note: The V2-to-V3 edge carries one historical message source kind

Status: implemented

English | [中文](2026-09-10-v2-to-v3-legacy-source-kind.zh.md)

## Problem

`dsh-session-format-v2-to-v3` classifies every Message source before it transforms one. `assertSource` in [`payload.ts`](../../../../packages/session/session-format-v2-to-v3/src/payload.ts) admits the fifteen released `source.kind` values and refuses anything else with `cannot safely transform unclassified message source`, because a transform that cannot name a source cannot promise it moved it safely.

An out-of-repo composer plugin, mounted on this machine while it was under evaluation, writes a `user/message` whose source is `{"kind":"at-file-mention","relative":"test/1.txt"}` and whose only content block is `<workspace-reference path="test/1.txt" kind="file" />`. The kind exists nowhere in this repository's history: `git log --all -S at-file-mention` is empty, and so is a grep over every checked-out plugin workspace.

The refusal costs more than that Session's history. `SqliteSessionQuery._reconcile` cold-reads every persisted Session it has not indexed, and one rejected read aborts the whole observation, so content search falls back to name matching library-wide. A cold-read replay of both of this machine's libraries through `JsonlSessionPersistence.open(id, 'read').read()` reaches this refusal for eight Sessions in `~/.dsh` and the same eight in the pre-rc.27 backup, once the three v0 shapes its sibling patch names stop refusing first.

## Decision

`LEGACY_UNINTERPRETED_SOURCE_KINDS` names `at-file-mention`, and `assertSource` returns for a named kind instead of throwing. The source object crosses to V3 with both of its members intact.

Carrying it verbatim is safe to state because the transform reads only two kinds: `plugin`, to rename the retired `tools-code-mode` owner, and `agent-message`, whose relay attribution it validates. Every other kind is data the edge copies. V3's own validators agree: `assertV3Event` treats an event whose type it cannot name as opaque, and the frozen relationship view `restoreReleasedV3Artifact` projects back through `restoreReleasedV2Artifact` leaves an unknown message-source `kind` as owner-opaque JSON, which is what the v0 and v1 generations already do with it.

The kind is carried rather than rewritten to `user`. Rewriting would drop the `relative` member and assert an origin the writer never claimed; the V3 artifact is durable, so a wrong claim would outlive the Session it describes.

Nothing widens into a general rule. An unnamed source kind is still refused with the same message, and the named set is a list of kinds observed on disk, not a policy for unknown plugins.

## What the two libraries say now

The same replay, with this patch and its v0 sibling in place: 139 of 139 Sessions in `~/.dsh` and 121 of 121 in the backup open. Both libraries reach zero refusals.

## Alternatives considered

**Rewrite the source to `{ kind: 'user' }`.** It needs no new inventory and produces a V3 artifact inside the frozen vocabulary. It also discards the `relative` member and states that a released writer produced the message, which is false for every Session that carries this kind.

**Admit any unclassified source kind.** One line, and it would cover the next out-of-repo composer without another patch. The refusal exists so that a kind reaching V3 has been read by someone; a blanket escape retires that guarantee for a cost the named list does not have.

**Leave the Sessions refused.** The kind is written by a plugin the fork does not ship, so the refusal is arguably upstream behaving as designed. It costs those Sessions their history and every library that holds one its content search, for a source member no code reads.

## Consequences

A Session carrying the kind opens, migrates, and indexes. The V2 file on disk is unchanged — the migration writes `session.v3.jsonl.zstd` beside it — so removing the migrated generation restores the previous refusal. A reader that switches on `source.kind` sees a value outside the released union in a V3 log; every such reader in this repository already treats an unknown kind as opaque.

## Testing

`legacy-uninterpreted.spec.ts` in `session-format-v2-to-v3` migrates the corpus payload verbatim, restores the V3 result, and pins the refusal for an unnamed kind on the same message.
