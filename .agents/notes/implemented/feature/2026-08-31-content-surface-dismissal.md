# Agent Note: Tab dismissal as a session event

Status: implemented

English | [中文](2026-08-31-content-surface-dismissal.zh.md)

## Problem

[The content-surface router](2026-08-24-content-surface-router.md) gave the column a switcher strip, but no way to remove anything from it. Once an entry existed it stayed in the stream forever — a redrawn chart or a re-shown page replaces its own record in place, but nothing ever left the list outright. A user who opened five pages over a long conversation had five tabs to scroll past, with no way to close the ones they were done with, and Chrome-style tabs (the shape the switcher strip already visually suggested) are expected to have a close button.

## Decision

Closing a tab is a durable, logged act, not a client-local hide. `content-surface/dismissed` (`{ kind, entryId, by: 'user' }`) is content-surface's first session event of its own — every other entry in the stream is still derived from a fact another package already logs, but dismissal is a fact only this router's own switcher strip produces, so it owns the event. It is not `ignorable`: an older build that does not recognize it must refuse the log rather than silently treat a dismissed entry as still live. Adding it did not bump `SESSION_FORMAT_VERSION` — ordinary vocabulary growth, per the [session-log-version-mechanism note](../architecture/2026-08-10-session-log-version-mechanism.md).

`projection.ts`'s fold treats `content-surface/dismissed` as the one event that bypasses the extractor table: it deletes the named `(kind, entryId)` record outright rather than running any `read`. This is a change to the fold's own control flow, not to which extractors are registered, so `extractor.ts`'s `foldVersion` — previously a pure function of the table — now also folds in a `FOLD_SEMANTICS_VERSION` constant, bumped from its implicit prior value of 1 to 2. A checkpoint written before the fold could delete a record is discarded rather than replayed under rules that did not exist when it was written, the same defensive posture a table change already got.

A dismissal is never validated against the live stream. The router keeps no catalogue of which `(kind, entryId)` pairs currently exist — extractors run inside the fold and nothing outside it tracks "current" state — so the command (`dismiss-content-entry`, content-surface's node half) appends the event for whatever pair its input names, unconditionally. A pair that is already gone folds to a no-op, exactly like a pair that never existed; there is nothing to reject. A later record naming the same pair (the agent redraws the chart, the user re-navigates to the page) is an ordinary fresh insert once the dismissed record is gone, so a dismissed entry resurrects exactly like one that was never dismissed — dismissal only ever removes, it never suppresses a future write.

The switcher strip's selection fallback needed no new logic. `selectedEntry` (content-column's `surface-seats.ts`) already fell back to the newest entry when the user's picked key was absent from `entries` — previously reachable only via the pick-was-replaced case (a redrawn chart keeps the same key, so this path was mostly theoretical) and the initial no-pick-yet case. Dismissal removing a record outright makes the picked-entry-is-gone case a live, common path for the first time, and the existing fallback already produces the right answer: it does not need to know why the key disappeared.

### Chrome-style tabs, never a button in a button

Each tab in the switcher is now a wrapper `<div>` around two sibling `<button>`s: the existing selection button (`data-content-surface-entry`, `data-content-surface-selected`, unchanged attributes) and a new close button (`data-content-surface-dismiss`, same `<kind> <entryId>` key). The two are independent DOM siblings, never one nested inside the other — an interactive element inside another interactive element is invalid HTML and unreliable to click-test, and putting the pill's border/background on the wrapper rather than either button keeps the visual "one tab" unit intact.

### Hiding the command's own chat echo

`dismiss-content-entry` is a command, like `show-content-page`, so its default rendering in the chat transcript would be a `GenericCommandCard` reading "success." Content-column registers its own empty `conversation.chat.commandview` entry at that key plus its own copy of the hiding stylesheet (`hide-empty-command-row.ts`, distinct `STYLE_ID` from content-frame's identical mechanism) — the durable dismissal record is the point, not a chat message narrating a tab the user just closed. This copies content-frame's existing mechanism for hiding `show-content-page`'s own echo rather than sharing it: content-column has no dependency on content-frame, and the two packages are fork-owned together in this deployment.

## Alternatives considered

**A client-local hide, never touching the log.** Rejected: a reload, a second browser tab, or a second device would all resurrect the "closed" entry, since nothing durable recorded the close. `content/shown` is durable for exactly the same reason — this event follows that precedent rather than treating dismissal as merely a view concern.

**Validate the dismissed pair against a live catalogue before accepting it.** Rejected for lack of a current owner: the router's fold has no persistent "currently live" index outside the state it is actively folding, event-by-event; building one solely to reject an already-harmless no-op is complexity with no current consumer asking for the rejection.

**Skip the `foldVersion` salt because no extractor table changed.** Rejected: the fold's own semantics changed (it can now delete a record, which it never could before), and the whole point of `stateVersion` is to invalidate a checkpoint whose fold no longer matches what produced it — tying it only to the extractor table would miss exactly this kind of change.

**A confirmation dialog or an undo affordance.** Rejected as unproven: the switcher strip has no other confirmation gesture today, and dismissal is already low-cost to reverse in the one way that matters — re-navigating to (or having the agent redraw) the same content resurrects the entry as an ordinary fresh record.

## Consequences

content-column now depends on `@deepseek-ai/dsh-client-ui-conversation` and requires `remote`/`remote.commands`, neither previously needed — the close button's command dispatch and its hidden-echo registration are what pulled both in. content-surface gains its first `@deepseek-ai/dsh-commands` dependency and its first session event, so its package invariant (previously a documented no-op) now validates `content-surface/dismissed`'s shape.

The switcher strip's DOM changed shape: what was one `<button>` per entry is now a wrapper `<div>` around two. Nothing outside `ContentSurface.tsx` read the prior single-button shape (`data-content-surface-entry`/`-selected` stayed put), so this did not require touching any other package.

content-column's own empty-state copy (`locales.ts`) is corrected in the same change: its Chinese "column.empty" string named 会话, a term banned from customer-visible text; it now says nothing about what kind of thing produced the entries, matching the fix's own scope rather than widening it further.

## Testing

`packages/experimental/content-surface/tests/projection.spec.ts` covers the fold directly: a dismissal removing its named record, a no-op fold against an already-gone pair, and resurrection through an ordinary `read` once the record is gone. `command.spec.ts` covers the command against the real registry (registration metadata, a successful dismissal, malformed input, HMR disposal). `invariant.spec.ts` covers the durable-shape checks on both the live append path and an existing bad record on disk. `command-child.spec.ts` covers the optional `commands` child the same way `prompt-section.spec.ts` covers the optional `systemPrompt` child.

`packages/experimental/content-column/tests/content-surface.client.spec.tsx` covers the close button as a DOM sibling rather than a nested button, dismissal calling the injected `onDismiss` with the right arguments, and the selection falling back once the picked entry is gone. `surface-seats.client.spec.ts` names the dismissal case explicitly alongside the pre-existing replaced-entry case. `dismiss.client.spec.ts` covers the command-execution seam's failure paths. `browser-plugin.client.spec.ts` covers the `content` registration's injected dismiss callback and the new `conversation.chat.commandview`/hiding-stylesheet registrations, mirroring content-frame's own coverage of `show-content-page`.

`apps/web/tests/content-surface.e2e.ts` drives the whole round trip against a real composition: closing a tab through the switcher removes it and falls the selection back, the durable `content-surface/dismissed` record is on the live agent's session log, a full page reload does not resurrect the dismissed entry, and appending a fresh `content/shown` for the same page does.
