# Agent Note: server-sidebar replaces ui-sidebar through the overlay pattern, not a mid-column extension point

Status: implemented

English | [中文](2026-08-29-server-sidebar-replaces-ui-sidebar.zh.md)

## Problem

The retrofit menu (page routes plus favorited sessions) needed a seat above the session list, below the New Session button — inside the shipped sidebar, not beside it. The shipped [`dsh-client-ui-sidebar`](../../../../packages/client/ui-sidebar/README.md) declares `sidebar` as one `single` slot and, inside its own component, five child slots (`sidebar.brand.mark`, `sidebar.brand.name`, `sidebar.workspaces`, `sidebar.settings`, `sidebar.footer.action`) with no seat between the New Session button and the workspace browser — the slot system has no mechanism for a third party to insert a sixth child into someone else's single-occupant component, and declaring one of those five keys twice throws (`ui-slots` rejects a duplicate key with a different type, and even an identical redeclaration is a second claim on a `single` slot's one occupant).

## Decision

**Replace the whole sidebar, the same way [`dsh-experimental-server-layout`](../../../../packages/experimental/server-layout/README.md) already replaces `dsh-client-ui-layout`.** `overlay/sidebar-menu.patch.yml` disables the `ui-sidebar` row and inserts `@deepseek-ai/dsh-experimental-server-sidebar` in its place. The new package's `ServerSidebarRoot` ports `SidebarRoot`'s whole behavioral contract verbatim — the 56px collapsed rail, the 150ms wide-content fade-out, the `.railIn` live-collapse-only animation, and the pointer-driven scrollbar linger — and re-declares the same five child slot registrations with the same kinds and scopes, so ui-workspace's and ui-settings's existing registrations, and any brand package filling the two identity slots, keep working with zero changes to those packages. The menu section is the one addition, seated between the New Session button and the `sidebar.workspaces` region.

Two engineering points this decision turns on:

- **The runtime registration and the TypeScript declaration are reused differently.** The `ctx.slots.register({ children: {...} })` call is restated in full — declaring is claiming, and every registrant states its own children regardless of whether another package already stated the identical spec. The `SlotMap` TypeScript interface augmentation for those same five keys is reused by a type-only import of `@deepseek-ai/dsh-client-ui-sidebar/client` instead: a second identical-type augmentation is legal (`ui-slots` only rejects a *conflicting* redeclaration), but importing the type keeps one documented source of truth for a registrant's compile-time contract regardless of which sidebar composed it, and the import is erased at build (a `type`-only import creates no module-graph request, so it costs nothing in the bundle).
- **Verified there was nothing else to carry over.** The precedent this decision follows had already missed one thing once (server-layout's own note on itself does not exist as a dedicated Agent Note, but the theme-projection carryover is documented in its README's Composition section) — so before committing to "replacement means the client half is the whole contract," the shipped `ui-sidebar` node half was read directly: `export function apply(): void {}`, an empty placeholder with no config, no service, no session event. There was nothing to carry over on the host side, and this package's own node half exists solely for the favorites feature below, which has no shipped counterpart at all.

## Alternatives considered

**Ask the slot system for a mid-component extension point inside `SidebarRoot`.** Rejected: it would require `dsh-client-ui-sidebar` itself to grow a new slot (`sidebar.menu` or similar) that no shipped consumer needs, turning an experimental package's requirement into a permanent addition to the official surface. The overlay-replacement pattern needs no upstream change at all.

**Compose the menu as a sixth `sidebar.footer.action` list entry.** Rejected: that slot is `wide`-only footer real estate (settings trigger, other bottom actions), not scoped or styled for a two-group navigation menu, and its owner share carries no room for the page catalog or favorites data this menu needs.

**Fork `dsh-client-ui-sidebar` in place (edit the shipped package) instead of overlay-replacing it.** Rejected by the repository's own coupling rule: cross-package edits to official packages for one experimental deployment's need are exactly what the overlay-replacement pattern exists to avoid, and it would make every future ui-sidebar change a merge conflict with this deployment's fork.

## Consequences

A composition wanting the retrofit menu carries `overlay/sidebar-menu.patch.yml` (typically alongside content-frame's own overlay, so the page-routes group has something to list). `dsh-client-ui-sidebar` itself is untouched — any deployment not composing this overlay is unaffected, and the official package's own tests, snapshots, and future changes need no awareness of this replacement existing.

The one thing this replacement cannot give an ui-sidebar consumer for free is anything the shipped sidebar might grow *after* this port: a new prop, a new child slot, or a geometry change to `SidebarRoot` lands in `dsh-client-ui-sidebar` and has to be manually re-ported into `ServerSidebarRoot` — there is no mechanism that keeps the two in sync automatically. This is the same maintenance cost `server-layout` already carries against `ui-layout`, not a new one.
