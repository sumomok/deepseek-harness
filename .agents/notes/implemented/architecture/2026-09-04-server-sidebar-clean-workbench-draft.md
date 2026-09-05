# Agent Note: server-sidebar — reusing the workbench draft only while it is clean

Status: implemented

English | [中文](2026-09-04-server-sidebar-clean-workbench-draft.zh.md)

## Problem

The product console's 工作台 promises one thing on a click: you land on a clean page. The recorded conversation is reused only when it still qualifies, and everything else falls through to the create path.

The test for "still qualifies" was `SessionSummary.blank` alone — has this conversation run a turn. That bit is deliberately narrow: standalone events never lower it (`sessionBlank` in `dsh-host-apiproxy`), and showing a content page is exactly such an event. So a draft the visitor had already navigated somewhere in read as blank and was reused: one 导航 click puts a published report on the content column, and the next workbench click lands the visitor back on that report instead of on a clean page. Nothing about that draft was clean except the one bit being consulted.

A configured home page sharpens the same problem from the other side. When content-frame's `homePage` names a page, the click path itself shows it on whatever draft it just resolved — so the reuse judgment now has to look at a content column that this very path is what populated, and must not read its own output as the visitor's content.

## Decision

**Clean is two conditions, not one: no turn has run, and the content column carries nothing beyond the deployment's configured home page.** `client/workflow-actions.ts` states both as pure predicates — `isCleanWorkbenchDraft` for the reuse decision, `hasShownHomePage` for the auto-open one — so the judgment is asserted against literal entry lists rather than through a rendered tree, and `openWorkbenchOnClick` keeps taking a single already-decided `reuse` input instead of growing a session-list read of its own.

**The configured home page is the one entry that does not disqualify a draft, because the click path is what put it there.** Counting it as content would make the mechanism defeat itself: the first click populates the draft, so every later click finds content and mints a new conversation, forever. The exception is narrow on purpose — it matches the home page id and the `page` kind, so a chart the agent drew, a different page, or a second entry alongside the home page all still disqualify.

**Entries are read off the session list's own `projectionValues.contentSurface.entries`, untyped at the read.** This is the same feed and the same defensive read `dsh-experimental-server-layout`'s `ShellFrame` performs for the content column's empty check. The read stays untyped rather than importing content-surface's projection type: a cross-package type import is not this repository's sanctioned way to couple two client-adjacent plugins (`packages/client/AGENTS.md`'s export discipline), and a composition that never composes content-surface — or a session that has shown nothing yet — must degrade to an empty list rather than throw mid-render. Two fields are compared and nothing else, which is what `ContentSurfaceEntryLike` names.

**A reused draft that already shows the home page skips the repeat `show-content-page`.** `content/shown` is a durable log record; re-issuing the command for the page already on display appends a second record describing no change. The freshly created outcome always gets the call regardless of that hint, because `homePageAlreadyShown` describes the recorded draft the click walked away from, not the session the call resolved — a distinction the browser tests pin directly.

**The judgment is computed where the session snapshot already lives.** `ServerSidebarRoot` holds the `useSessions` subscription, so it computes both booleans and passes them through the injected action; the injected side stays a plain function of its arguments. This keeps the sidebar's one reactive read of the session list where it already was, instead of opening a second one inside an action that would then need a session tree to test.

## Alternatives considered

**Show the home page without appending `content/shown`.** Rejected: the content column is model-visible, and model-visible ⟺ logged. A page on display that no event records is unreconstructable from the log, and it would also strand the column's own replay. The [`content/shown` writer discriminant](2026-08-29-content-shown-writer-discriminant.md) already settled that a user-triggered show is recorded with `by: 'user'`; this path is one.

**Lower `SessionSummary.blank` for content shows.** Rejected: `blank` is a core fact with other consumers — the hero placeholder, the session list — and it means "has run no turn" for all of them. Widening it to "has any standalone event" would change surfaces that have nothing to do with this console, in upstream core, to answer a question one fork-owned plugin asks.

**Clear the draft's content on reuse instead of judging it.** Rejected: the entries were put there by the visitor on purpose, and this package's own rule for restoring a conversation is that it only fills in what is missing (decision ⑦). A click that silently discarded durable records would be the more surprising behavior, not the cleaner one.

**Have the sidebar remember whether it had shown the home page itself.** Rejected: a second bookkeeping mechanism over a fact the session log already carries, and one that is wrong the moment the visitor reloads or opens a second tab. The same reasoning kept decision ④'s unread dot on the session list's own `completed` bit.

**Read the session list inside `openWorkbenchOnClick`.** Rejected: it duplicates a subscription the component already holds and makes a pure open-or-create action need a live session tree to test.

## Consequences

With no `homePage` configured, any content-surface entry at all disqualifies a draft. That is the intended reading rather than an omission: with no configured page, no entry can be this path's own output, so every entry is the visitor's.

**Refusing to reuse is not yet the same as displacing.** The create path a rejected draft falls through to resolves through `resolveOrCreateSession` → `connectWorkspace`, and that function's own reuse scan hands back the first blank session the Workspace already holds, in the session list's own order — a draft rejected purely for its content has still run no turn, so it qualifies, and it is the one handed back unless that Workspace holds another blank session ahead of it, in which case `workbenchSessionId` is repointed there instead. What the content half of the judgment therefore produces today is the configured home page shown again on a conversation that already existed, with the page the visitor had navigated to still sitting in that draft's switcher strip; the dedup half is the one that changes behavior outright. Making the refusal actually displace needs a create path that bypasses that scan for this caller alone, and taking that also decides how many abandoned blank conversations a navigate-then-click cycle may leave behind — which is a product decision, so it is recorded as a Known Limitation instead of taken here.

The `apps/web` scenario's home-page block now carries both halves end to end: a second click reuses the draft its own first click populated, adding no session and no second `content/shown` record; and a draft the visitor has navigated elsewhere fails the content half while `SessionSummary.blank` still reads true, so that click shows the home page again — landing back on the same conversation, which is the paragraph above asserted rather than assumed.
