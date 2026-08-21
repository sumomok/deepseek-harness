# @deepseek-ai/dsh-experimental-server-layout

English | [中文](README.zh.md)

The shell frame for the service-line web product: four resident grid tracks — the session list, a content column, the chat column, and the details band — split on a fixed 24-unit ratio of 3:16:5. It replaces [`dsh-client-ui-layout`](../../client/ui-layout/README.md) in a composition rather than sitting beside it, because `root` is a single slot and its child slots may be declared only once.

The content column is what this product line is built around and the reason the package exists: a resident work surface between navigation and conversation, which the shipped three-column shell has no seat for. This version ships the column, not its contents — an unclaimed `content` slot renders the shell's own empty-state body.

## Replacing the shipped shell

A shell replacement is only a drop-in if it honors everything the shipped one published, so this package reproduces all three of ui-layout's outward surfaces:

- **The four child slots** — `sidebar`, `conversation`, `details`, and `shell.overlay` keep their kinds, scopes, and owner shares. The declarations are reused from ui-layout by type import rather than restated, so a registrant compiles against one documented contract regardless of which shell is composed.
- **`ctx.layout`** — the same `ILayout` face (`toggleSidebar`, `openDetails`, `closeDetails`), provided in the same synchronous effect that registers the root entry, and provided *first*. That order is what makes ui-sidebar and ui-conversation work unchanged: both inject `layout` and both register into these child slots without waiting for a declaration, so by the time the service resolves their fibers the slots already exist.
- **The document theme projection** — `ctx.theme` resolves the active theme but never touches the DOM; the shell is what writes root `color-scheme`, the body palette attribute, and the theme's alias tokens. A composition that dropped this would keep its base palette from the host's boot script and silently stop responding to the Appearance preference.

Geometry differs on purpose. There are no drag handles, no concession chain, and no width preferences: the tracks are a pure function of the measured frame width and two booleans (`tracks.ts`), so any resize reproduces the same ratio and nothing has to be restored. A folded session column renders the 56px control rail and leaves its ratio units to content and chat, which keep dividing what is left on their own 16:5. The details band takes a fixed 360px off the top when open and zero when closed, and its subtree stays mounted at that zero width.

Widths reach CSS as pixels rather than `fr` because the session column's occupant renders its own inline width from the `width` owner prop — an `fr` track would leave that number unknowable and the two would drift.

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

## Registering into the content column

`content` is a `single`, `root` slot with an empty owner share. It receives no owner props, and it mounts once for the page's lifetime: no session transition remounts it. That is what makes the column able to hold DOM state a switch must not destroy — a live iframe document is the case it was built for — and it puts the session question on the occupant, which reads the current session through the root standard hook `useSessions` and decides for itself what a switch changes.

```ts ignore-check
ctx.slots.inject('content', () => ctx.slots.register({ name: 'content' }, MySurface))
```

The first registration claims the column outright and the shell's placeholder disappears with it.

## Model Experience

None, as the shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No responsive behavior** — the ratio is applied at every width, so a narrow viewport squeezes all four columns rather than folding the session column or stacking. The shipped shell's auto-collapse breakpoint and concession chain have no counterpart here; a deployment that needs them should compose ui-layout instead.
- **No resize affordance** — column widths are not user-adjustable and not persisted. Ratio and rail width are contract-frozen constants, not configuration.
- **The content column is a shell only** — this package ships the seat, its empty state, and its geometry. What renders inside belongs to the occupant; [`content-frame`](../content-frame/README.md) is the first one.
- **A root-scoped column leaks per-session state unless its occupant keys it** — the framework clears nothing on a session switch, so an occupant holding per-session component state must key it by session id itself. That cost buys the column's whole point: DOM the framework may not destroy. The other three columns keep their session scopes.
- **No browser theme-color metadata** — the shipped shell also maintains a `<meta name="theme-color">` whose content follows the computed body background, which colors surrounding browser UI on mobile. This shell omits it, consistent with having no responsive behavior to serve that surface.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario run against a real composition, not a recorded transcript; the snapshot lanes project model-visible and conversation output, which this package has none of.
