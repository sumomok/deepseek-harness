# Agent Note: a favorite is a weak reference to a session id, never silently dropped

Status: implemented

English | [中文](2026-08-29-favorites-weak-session-reference.zh.md)

## Problem

`@deepseek-ai/dsh-experimental-server-sidebar`'s favorites menu names sessions by id in a document that outlives any one session: a favorite persists in the `settings` capability's durable document ([per-account, one `$DSH_HOME` per user](../../../../packages/settings/settings-file/README.md)), while the session it names can be deleted through the ordinary workspace UI at any time, by the same user, with no coordination between the two features. Nothing in this package observes session deletion — the workspace domain that owns deletion has no reason to know a settings document elsewhere might reference an id it just removed, and wiring that notification would couple two otherwise-independent capabilities for one feature's bookkeeping. The favorites document therefore *will* end up naming a session that no longer exists, as an ordinary and expected occurrence, not a failure.

## Decision

**A favorite is a weak reference, resolved fresh at render time, never validated at write time.** `ServerMenuFavorite` carries a bare `sessionId: string` with no existence check anywhere in the write path — not in the `POST /server-menu/favorites` route's schema validation, not in the settings namespace's `validate` hook, not in the package's invariant. The one relation those three enforce is internal to the document itself (no two favorites may name the same session); whether a named session currently exists is a fact the document does not and cannot promise, because it can go stale the instant after a successful write.

**Staleness is a browser-side, per-render computation, not a durable flag.** `ServerSidebarRoot` derives `liveSessionIds` from the standard `useSessions` snapshot on every render (`useMemo` keyed on `byId`), and the menu checks each favorite against that live set at display time. A favorite whose session was deleted renders as a grayed-out, non-navigable row carrying an explicit "session deleted" label, its rename action hidden (there is nothing left to rename it to reach), and its remove action still present — the row stays visible and actionable for cleanup, it is never filtered out of the list silently. This is a deliberate product requirement, not an implementation default: a silently-dropped favorite would look like data loss to a user who saved it and later can't find it, with no way to tell the two apart.

## Alternatives considered

**Validate `sessionId` against the live session list at write time (`POST` or `settings/updated`).** Rejected: it only prevents *adding* a favorite for a session that doesn't exist yet — it does nothing for the far more common case, a session that existed when favorited and was deleted afterward. The document would still go stale on the very next deletion, so the check buys correctness for a narrow window and none for the case that actually matters, while adding a dependency from the settings write path to the live session list (which does not exist in the node half's process the same way, and may not exist at all in a composition without the sessions runtime loaded).

**Have deletion clean up any favorite naming the deleted session.** Rejected: it requires the workspace/session deletion path to know about this package's settings namespace, inverting the ownership this repository's capability-seam conventions ask for (a capability's provider does not reach into an unrelated consumer's durable data on every operation). It would also silently remove a user's own labeled bookmark — the exact "quietly discarded, no trace" outcome the render-time approach exists to avoid, just moved from read time to write time.

**Silently filter stale favorites out of the rendered list.** Rejected as the literal thing this decision refuses: a user who favorited a session, had it later deleted (intentionally or not), and then can't find the favorite in the list has no way to know whether it was ever saved at all. A gray, labeled, removable row turns an invisible data-integrity question into a visible, one-click-resolvable UI state.

**Store a denormalized snapshot of the session's title at favorite-time, shown even when stale.** Rejected: the favorite's `label` is already a user-chosen name independent of the session's own title (the whole point of a favorite is a name the user picked, not the session's own), so a second denormalized title would answer a question nobody asks. The stale-state label ("session deleted") already tells the user everything the row's disabled action would have told them.

## Consequences

The favorites schema stays minimal — `{ sessionId, label, order }` — with no status field, no snapshot, and no last-verified timestamp. The cost is a repeated `O(favorites × liveSessionIds)` membership check on every render (a `Set` lookup per favorite, over a snapshot already read for the "current session" derivation this same component needs), which is negligible at the "handful of sessions" scale a real favorites list has.

Nothing about this decision requires the favorites document to ever fully agree with the live session list, and nothing enforces that it eventually would — a stale favorite persists until its owning user removes it by hand. That is the intended shape of a weak reference: correctness lives at read time, forever, rather than being chased at every point of write.
