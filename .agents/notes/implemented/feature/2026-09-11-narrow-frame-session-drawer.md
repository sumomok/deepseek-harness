# Agent Note: the console sidebar collapses to a top-left hamburger drawer below 1024px

Status: implemented

English | [中文](2026-09-11-narrow-frame-session-drawer.zh.md)

## Problem

The service-line console shell (`packages/experimental/server-layout`) tiles four grid tracks on a fixed 24-unit ratio with no responsive behavior. The [session column floor](../bug-fix/2026-09-11-session-column-floor.md) stopped a narrow frame from crushing session titles one glyph per line by holding the expanded session column at 180px — but that floor takes 180px of a phone-width window a session list has no room for, leaving the chat column under 360px below about 540px. The floor note deliberately deferred a drawer or overlay as out of scope for a geometry fix. The product owner's screenshot of the console at ~500px is the report that the deferred work is now needed.

## Decision

**Below `SIDEBAR_AUTO_COLLAPSE` (1024px) the session column leaves the grid entirely and its list moves to an off-canvas overlay drawer the frame draws over the content.** The whole mechanism lives in `server-layout`; the sidebar occupant (`server-sidebar`) is unchanged.

- `tracks.ts` gains two contract-frozen constants beside `SESSION_RAIL` and `DETAILS_WIDTH` — `SIDEBAR_AUTO_COLLAPSE = 1024` and `SIDEBAR_DRAWER = 280` — a pure `isNarrow(frame)` predicate, and a fifth `narrow` boolean on `solveTracks`. When `narrow`, the session track solves to 0 (not the 56px rail) and content and chat divide what the details band leaves on their 16:5, content still collapsing to 0 when empty. The tracks still sum to the frame whenever it is positive. Above the breakpoint the solve is byte-for-byte what the floor note produced.
- The panel store gains a transient `drawerOpen` flag (default false), `openDrawer`/`closeDrawer`, and a `narrow` mirror set by `setNarrow`. `toggleSidebar` — the one `ctx.layout` fold verb external callers reach — means the fold on a wide frame and the drawer on a narrow one, where the column is out of the grid and the rail has nowhere to show. `setNarrow` forces the drawer closed when the frame widens back past the breakpoint, so no overlay survives onto a wide layout.
- `ShellFrame` mirrors `isNarrow(frame)` into the store, renders a top-left hamburger in its existing `shell.overlay` layer while narrow and closed, and while narrow and open renders the same `sidebar` slot as a left-anchored drawer at `SIDEBAR_DRAWER` (clamped to the frame) behind a scrim. The drawer slides in and the scrim fades, both held still under `prefers-reduced-motion`. Focus moves into the drawer on open and back to the hamburger on close, without a focus-trap dependency. The drawer is dismissed by the scrim (pointer) and the Escape key (keyboard).
- Copy is locale-owned: `sidebar.open` (the hamburger's label) and `sidebar.navigation` (the drawer's region label) are added to both the `zh` and `en` `serverLayout` dictionaries.

**A navigation tap does not auto-close the drawer.** `server-sidebar`'s `open-nav.ts` resolves a nav target with `resolveOrCreateSession({ reuseCurrent: true })`, so opening a page or view shows content in the *current* session rather than switching it. No session switch reaches `ShellFrame`, so the current-session change it can observe fires only for the session-switching opens (workbench, workflows), not the common page/view open. Rather than close inconsistently, the drawer never auto-closes on nav; the scrim, Escape, and `ctx.layout.toggleSidebar()` are the complete dismissal set.

## Alternatives considered

**A 56px persistent rail below the breakpoint (the shipped shell's fold).** Rejected. `ui-layout` collapses its sidebar to a 56px icon rail at narrow widths, but this console's sidebar is decision ①'d to render its full content and never toggle — it has no rail UI — and a 56px column on a 500px frame is still 56px this product's content-and-chat layout cannot spare. Taking the column out of the grid entirely and floating the full list over the content on demand gives the narrow frame all of its width back.

**A wide-mode fold control (a hamburger or toggle that folds the session column on a desktop frame).** Rejected as unbuilt scope. The console has no wide-mode fold control today, and inventing one is a separate product decision; the responsive work is only about the narrow frame. `toggleSidebar` still folds on a wide frame for any external caller that wants it, exactly as before.

**Auto-close the drawer on a navigation tap.** Preferred but not cleanly observable. It would require either editing `server-sidebar` to signal the frame, or watching the current session's content-surface entries for a same-session change — which deepens the soft, untyped coupling the package README already flags as a known limitation. Closing only for session-switching opens would make the drawer's dismissal inconsistent between nav kinds, which reads worse than a single manual dismissal. So the drawer ships scrim + Escape + the layout toggle, and the limitation is documented.

**A `narrow` config field or a configurable drawer width.** Rejected. The breakpoint and drawer width are contract-frozen geometry beside the ratio, the rail, and the details width, for the same reason those are: the shell's geometry is a fixed product decision so a registrant renders identically under every composition. The README lists them as contract-frozen constants, not gaps.

## Consequences

- Every frame at and above 1024px solves exactly as it did after the floor note; only frames below it change, and there the session column is 0 and the drawer holds the list. The sum invariant holds at every width.
- The sidebar occupant mounts fresh each time the drawer opens rather than living once for the page's lifetime, because it renders in the drawer only while open. This is acceptable: the narrow path is not the console's primary desktop use, and the sidebar reads the current session from `useSessions` and rebuilds. The content column — the one that must not lose DOM state across a switch — is untouched.
- A navigation tap in the drawer leaves it open; the user dismisses it with the scrim or Escape. This is the documented limitation, driven by the nav path reusing the current session.

## Testing

`tracks.client.spec.ts` pins `isNarrow` at the 1024/1023 boundary, the session column leaving the grid at 500px (session 0, chat 500), the details band surviving while narrow, a narrow-but-folded frame still solving to 0, and the breakpoint boundary end-to-end; the tiling property test gains `narrow` as a fourth loop dimension. `panel-store.client.spec.ts` covers `openDrawer`/`closeDrawer`, `toggleSidebar` picking the drawer once narrow, and `setNarrow` mirroring the breakpoint and dropping the drawer on widen. `shell-frame.client.spec.tsx` covers the narrow render (hamburger shown, in-grid session occupant gone), opening the drawer with its scrim at the clamped width, focus moving into the drawer and back to the hamburger, Escape closing while a non-Escape key does not, and a widen past the breakpoint clearing the drawer. Per-file coverage stays at 100%.
