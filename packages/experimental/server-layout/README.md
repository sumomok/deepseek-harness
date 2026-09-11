---
description: "The service-line shell: a permanent four-track AppFrame (session, content, chat, details) replacing ui-layout through a patch overlay, with the content column collapsing when nothing claims it; for deployments composing the service-line product experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-server-layout

English | [中文](README.zh.md)

## Summary

The shell frame for the service-line web product: four resident grid tracks — the session list, a content column, the chat column, and the details band — split on a fixed 24-unit ratio of 3:16:5. It replaces [`dsh-client-ui-layout`](../../client/ui-layout/README.md) in a composition rather than sitting beside it, because `root` is a single slot and its child slots may be declared only once.

The content column is what this product line is built around and the reason the package exists: a resident work surface between navigation and conversation, which the shipped three-column shell has no seat for. This version ships the column, not its contents — an unclaimed `content` slot renders the shell's own empty-state body.

## Table of Contents

- [Replacing the shipped shell](#replacing-the-shipped-shell)
- [Composition](#composition)
- [Registering into the content column](#registering-into-the-content-column)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="replacing-the-shipped-shell"></a>
## Replacing the shipped shell

A shell replacement is only a drop-in if it honors everything the shipped one published, so this package reproduces all three of ui-layout's outward surfaces:

- **The four child slots** — `sidebar`, `conversation`, `details`, and `shell.overlay` keep their kinds, scopes, and owner shares. The declarations are reused from ui-layout by type import rather than restated, so a registrant compiles against one documented contract regardless of which shell is composed.
- **`ctx.layout`** — the same `ILayout` face (`toggleSidebar`, `openDetails`, `closeDetails`), provided in the same synchronous effect that registers the root entry, and provided *first*. That order is what makes ui-sidebar and ui-conversation work unchanged: both inject `layout` and both register into these child slots without waiting for a declaration, so by the time the service resolves their fibers the slots already exist.
- **The document theme projection** — `ctx.theme` resolves the active theme but never touches the DOM; the shell is what writes root `color-scheme`, the body palette attribute, and the theme's alias tokens. A composition that dropped this would keep its base palette from the host's boot script and silently stop responding to the Appearance preference.

Geometry differs on purpose. There are no drag handles, no concession chain, and no width preferences: the tracks are a pure function of the measured frame width and four booleans (`tracks.ts`), so any resize reproduces the same ratio and nothing has to be restored. The one fixed point on the ratio is the expanded session column's 180px floor (`SESSION_MIN`): 3/24 of a 1440px frame is 180px, so a wider frame solves exactly on the ratio and a narrower one holds the column at 180px while content and chat divide what remains on their 16:5 — the share alone would leave a 500px window a 63px column that wraps every session title one character per line. A folded session column renders the 56px control rail and leaves its ratio units to content and chat, which keep dividing what is left on their own 16:5. The details band takes a fixed 360px off the top when open and zero when closed, and its subtree stays mounted at that zero width.

Below `SIDEBAR_AUTO_COLLAPSE` (1024px, the deepsuite LG breakpoint the shipped shell also folds at) the session column leaves the grid entirely — its track solves to zero and content and chat divide the whole frame — and the session list is reached instead through an off-canvas drawer the frame draws into its overlay layer. A top-left hamburger opens it, a scrim click or the Escape key closes it, and the same `sidebar` occupant fills it at `SIDEBAR_DRAWER` (280px, clamped to the frame). Focus moves into the drawer on open and back to the hamburger on close, and the slide-in and scrim fade hold still under `prefers-reduced-motion`. Widening back past the breakpoint forces the drawer closed, so no overlay survives onto a wide layout. The sidebar occupant is unchanged across both — it lays itself out against whatever width it is handed, in the grid column or the drawer.

The content column collapses the same way while it has nothing to show: zero width, chat absorbing the reclaimed share, the subtree kept mounted underneath. The frame reads this off the current session's content surface through the standard `useSessions` list feed rather than importing [`content-surface`](../content-surface/README.md) — see Known Limitations for what that soft coupling costs.

Widths reach CSS as pixels rather than `fr` because the session column's occupant renders its own inline width from the `width` owner prop — an `fr` track would leave that number unknowable and the two would drift.

<a id="composition"></a>
## Composition

The plugin is not part of any shipped bundle. Compose it as an overlay over the Web surface:

```yaml
- id: ui-layout
  name: '@deepseek-ai/dsh-client-ui-layout'
  disabled: true

- insert:
    - id: server-layout
      name: '@deepseek-ai/dsh-experimental-server-layout'
```

`overlay/three-column.patch.yml` is that file; `dsh --profile web --patch <path>` applies it. A disabled row never reaches the browser boot manifest, so the browser fetches this bundle instead of ui-layout's. The package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

<a id="registering-into-the-content-column"></a>
## Registering into the content column

`content` is a `single`, `root` slot with an empty owner share. It receives no owner props, and it mounts once for the page's lifetime: no session transition remounts it. That is what makes the column able to hold DOM state a switch must not destroy — a live iframe document is the case it was built for — and it puts the session question on the occupant, which reads the current session through the root standard hook `useSessions` and decides for itself what a switch changes.

```ts ignore-check
ctx.slots.inject('content', () => ctx.slots.register({ name: 'content' }, MySurface))
```

The first registration claims the column outright and the shell's placeholder disappears with it.

<a id="model-experience"></a>
## Model Experience

None, as the shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One responsive fold, no stacking or concession chain** — at and above `SIDEBAR_AUTO_COLLAPSE` (1024px) the ratio is applied at every width, the session column's 180px floor being the only exception; below it the session column leaves the grid for an off-canvas drawer and content and chat divide the frame on their 16:5. Nothing stacks, and the shipped shell's concession chain and drag handles still have no counterpart here; a deployment that needs them should compose ui-layout instead.
- **The drawer is a fixed width, has no wide-mode fold control, and a nav tap does not dismiss it** — the drawer opens at `SIDEBAR_DRAWER` (280px, clamped to the frame), not a share, and above the breakpoint there is no fold control to reclaim session width (the shipped shell's is the one to use). A navigation tap reuses the current session (`open-nav.ts`'s `resolveOrCreateSession({ reuseCurrent: true })`), so no session switch reaches the frame to auto-close the drawer on it, and watching the content surface for a same-session change would deepen the soft coupling below; the drawer is dismissed by the scrim, the Escape key, or `ctx.layout.toggleSidebar()`.
- **No resize affordance** — column widths are not user-adjustable and not persisted. Ratio and rail width are contract-frozen constants, not configuration.
- **The content column is a shell only** — this package ships the seat, its empty state, and its geometry. What renders inside belongs to the occupant; [`content-frame`](../content-frame/README.md) is the first one.
- **A root-scoped column leaks per-session state unless its occupant keys it** — the framework clears nothing on a session switch, so an occupant holding per-session component state must key it by session id itself. That cost buys the column's whole point: DOM the framework may not destroy. The other three columns keep their session scopes.
- **No browser theme-color metadata** — the shipped shell also maintains a `<meta name="theme-color">` whose content follows the computed body background, which colors surrounding browser UI on mobile. This shell omits it, consistent with having no responsive behavior to serve that surface.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario run against a real composition, not a recorded transcript; the snapshot lanes project model-visible and conversation output, which this package has none of.
- **The content-empty read is a DOM-free but shape-coupled reach into another package** — `ShellFrame.tsx` reads `contentSurface.entries` off `useSessions`' per-session `projectionValues` with everything typed `unknown`, rather than importing [`content-surface`](../content-surface/README.md)'s types (this package declares no dependency on it, and a composition without it simply always collapses the column, which is a correct answer). A future change to that key's shape or name breaks the read silently — the column would stop collapsing (or collapse when it should not) with no compile-time signal, only a wrong-looking layout.
- **The content collapse can flash on first paint** — the session-list projection value arrives asynchronously, so a session that already has content briefly renders the collapsed (16:5 folded to chat-only) layout before the first snapshot lands and the content column expands. The `grid-template-columns` transition (`ShellFrame.module.css`) animates that expansion rather than snapping it, but the single flash on initial load is not suppressed.

**Runtime invariant:** No companion is published. The shell's panel store emits no cordis event and holds no durable data, and the only relationship this package owns — the root registration plus the `ctx.layout` face it provides in the same effect — is a slot/service effect whose install and teardown this package's own specs exercise directly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
