# Agent Note: The v0 identity edge accepts three legacy shapes this fork's Sessions carry

Status: implemented

English | [中文](2026-09-07-v0-migration-legacy-shapes.zh.md)

## Problem

The released v0→v1 identity edge refuses any event type outside its frozen inventory and any payload member outside a type's disposition. That policy is what keeps a migrated Session exact, and it assumes the inventory names every shape a shipped build ever wrote. This fork shipped builds that wrote three shapes it does not name, so the Sessions those builds wrote no longer open.

A refusal does not stay inside the Session that carries it. `SqliteSessionQuery._reconcile` cold-reads every persisted Session it has not indexed, and one rejected read aborts the whole observation: `_observeStable` wraps it as `SESSION_QUERY_PERSISTENCE_FAILED` in [`session-query-sqlite/src/index.ts`](../../../../packages/session-query/session-query-sqlite/src/index.ts), the search falls back to name matching, and the workspace browser shows `内容搜索暂不可用，仅显示名称匹配。` for every Session in the library. One old log therefore costs content search entirely, in addition to costing its own history.

The measurement is a cold-read replay of both libraries through `JsonlSessionPersistence.open(id, 'read').read()`, the same call the reconcile makes. On the 0.1.5-rc.1 base with the out-of-repo event types already carried, 9 of the 139 Sessions in `~/.dsh` and 22 of the 121 in the pre-rc.27 backup are refused. Because the edge stops at the first fault in a Session, those refusals name four distinct reasons: the three shapes below, plus an out-of-repo message source kind the next edge refuses, which its own sibling patch names.

`permission/preset N data has unexpected member "origin"` — 11 Sessions in the backup library and 2 in `~/.dsh`, whose v0 logs are the ones no rc.31 build had already migrated. A build from mid-2026-08 recorded next to the preset name where the name came from: `{"type":"permission/preset","seq":0,"time":1787322888043,"data":{"preset":"workspace-write","origin":"default"}}` and `{"type":"permission/preset","seq":4,"time":1787322901591,"data":{"preset":"yolo-access","origin":"selection"}}`. Those two values are the only ones on disk, and `@deepseek-ai/dsh-permission-presets` now appends `{ preset }` alone.

`subagent/descriptor N uses unsupported descriptor version 2` — 4 Sessions in the backup library, for example `{"type":"subagent/descriptor","seq":0,"time":1787709640297,"data":{"version":2,"mode":"continuable","provider":"spawn","label":"调研黄金类资产与矿股PE","agentProvider":"deepseek-official","agentModel":"deepseek-v4-flash-vision-exp"}}`. Upstream raised `SUBAGENT_DESCRIPTOR_VERSION` from 2 to 3 in PR #2663; the payload validator accepts version 3 only.

`format v0 contains unknown historical event type "content/shown"` — 6 Sessions in the backup library, for example `{"type":"content/shown","seq":209,"time":1788074166009,"data":{"page":"reports","by":"user"}}`. The content surface of this fork's `product/server-console` line wrote it while desktop builds mounted that console.

## Decision

[`migration.ts`](../../../../packages/session/session-format-v0-to-v1/src/migration.ts) gains two normalizers in the chain each v0 event already passes through before its payload is validated. `normalizeLegacyPermissionPreset` removes the `origin` member and nothing else. `normalizeLegacySubagentDescriptor` rewrites `version: 2` to `version: 3` and touches no other member. [`dispositions.ts`](../../../../packages/session/session-format-v0-to-v1/src/dispositions.ts) names all six content event types the `product/server-console` line writes — `content/shown`, `content/navigated`, `content-surface/selected`, `content-surface/dismissed`, `content-component/shown`, `content-component/resolved` — in `LEGACY_UNINTERPRETED_EVENT_TYPES`, so each is carried verbatim and reaches v2 marked `ignorable: true` for the installed restorer. `session-format-v1-to-v2` reads that same set, so naming a type once covers both edges.

The descriptor is renumbered rather than carried through because the promotion is total. Upstream PR #2663 adds one optional member, `agentReasoningEffort`, to the continuable descriptor and changes nothing else, so a version-2 payload is exactly a version-3 payload that declares no child reasoning effort — no field has to be guessed and none is lost. Carrying version 2 through, the way the v1 branch of `assertReleasedEventPayload` already tolerates a non-3 version, would not open the Session at all: `session-format-v1-to-v2` has no such escape, so its v2 target validation reaches `subagentDescriptorValue` and refuses with `subagent/descriptor N version must be one of 3`. Renumbering is what lets the Session migrate, and it additionally leaves the payload in the one generation `parseSubagentDescriptor` in `@deepseek-ai/dsh-subagent` classifies.

The `origin` member is removed rather than admitted to the inventory. `RELEASED_V0_EVENT_DISPOSITIONS` states that every member it lists is preserved by the identity edge, and `session-format-v1-to-v2` derives the v2 inventory from it, so listing a member the edge drops would be false in one package and would admit the member into two later generations no writer emits it in. Removing it in a normalizer is what the edge already does with the obsolete `request/header.header.messagePrefix`.

Nothing here widens into a general rule. The allowlist stays a list of types observed on disk, an unexpected payload member other than `origin` is still refused, a descriptor version other than 2 is still refused, and an event type marked `ignorable: true` that nobody named is still refused.

## What the two libraries say now

The same replay after the change: 131 of the 139 Sessions in `~/.dsh` and 113 of the 121 in the backup open, and none of the three shapes refuses any more. The eight that still refuse in each library are the same eight Sessions, stopped one generation later by the V2-to-V3 edge over an out-of-repo `user/message` source kind; the sibling patch that names that kind takes both libraries to zero refusals. `session-c5f7ab97-7485-4955-9ee0-f07c98a05d85`, which an earlier base refused for an unclosed turn once its `origin` member stopped refusing first, opens here: the V1-to-V2 edge closes an interrupted turn itself on this base.

`content-surface/dismissed` was found the same way — it only became reachable once the shapes ahead of it stopped refusing first. A scan of every row in both libraries bounds what those two libraries hold: outside the frozen inventory and the packed physical row tags they carry exactly `content/shown`, `content-surface/dismissed`, and the already-named `permissionRules/decision`; `permission/preset` carries no member beyond `preset` and `origin`; and no `subagent/descriptor` on disk is at a version other than 2. Only two of the six content types therefore appear in these libraries. All six are named anyway, because one product line writes all six and another user's library reaches the same refusal for any of them; `git diff HEAD product/server-console -- packages/core/session/src/known-event-types.ts` is the list.

## Alternatives considered

**Admit `origin` as an optional member of the frozen `permission/preset` disposition and keep it in the migrated Session.** It is the smaller edit and preserves a fact the old build recorded. It also makes the inventory contradict its own documented meaning, propagates the member into the v2 inventory that `session-format-v1-to-v2` derives from it, and lets a v1 or v2 artifact carry a member no released writer emits, where nothing downstream reads it.

**Carry a version-2 `subagent/descriptor` through unchanged.** The v1 branch of the payload check already returns without complaint for a non-3 version, so extending that to v0 is a two-line change with no promotion logic. It restores nothing: the v1→v2 edge validates its target through the same released semantics and refuses `subagent/descriptor N version must be one of 3`, so the Session moves one generation and then stops. A probe against both edges confirms it — version 2 refused, version 3 migrated.

**Let any historical event marked `ignorable: true` through the edge.** This would have covered `content/shown` and `content-surface/dismissed` at once, and every future out-of-repo event type without another patch. The edge's refusal message says explicitly that `ignorable: true` does not exempt a historical event, and that stance is what stops an arbitrary third-party payload from entering a frozen generation unexamined. A named list costs one line per type actually observed.

**Repair the refusing Sessions on disk.** Rewriting the refused logs would need no code change to the edge at all. It edits durable history the fork does not own, it cannot reach a user's machine, and it would have to be repeated for every library that still holds these builds' output.

## Consequences

A Session carrying any of the three shapes opens, migrates, and indexes, and content search stops failing library-wide because of it. The v0 file on disk is unchanged — the migration writes `session.v3.jsonl.zstd` beside it — so the previous refusal is recoverable by removing the migrated generation. A migrated `permission/preset` no longer records where the preset came from; nothing in the current build reads that fact, and the preset name itself is preserved. A migrated `subagent/descriptor` reports version 3, and its `agentReasoningEffort` is absent, which is what the version-2 payload meant.

The eight Sessions each library still refuses are stopped by the next edge, not by this one, and the sibling patch for that message source kind is what clears them. Until a library has both patches, the reconcile aborts on the first rejected read and content search stays unavailable there.

## Testing

`legacy.spec.ts` in `session-format-v0-to-v1` pins each shape — the two corpus payloads are verbatim — and pins the refusal that proves the acceptance is narrow: a `permission/preset` payload that carries `origin` and also a `foo` member, a descriptor at version 1, and an unnamed `content-surface/whatever` event. `migration.spec.ts` in `session-format-v1-to-v2` carries all six content types across that edge and pins both descriptor versions there. Package coverage stays at per-file 100%.

The corpus replay is not a repository test. It reads a private copy of two real libraries, so it lives outside the tree and its numbers are recorded above.
