# Agent Note: The product-console line on the 0.1.7-rc.2 base — the menu as Config, the shell on `main`/`rightbar`

Status: implemented

English | [中文](2026-09-26-server-console-on-the-rc-2-base.zh.md)

## Problem

The 0.1.7-rc.2 base removed three seams the console line was built on. The settings capability no longer offers plugin-owned namespaces: `settings.register`, `SettingsScope`, the `settings/updated` event, and the `settings.yaml` file provider are gone, and the settings service now edits plugin `Config` fields declared `.volatile()`. The shipped shell's root children are now `sidebar`, `main`, `rightbar`, `shell.overlay`, and `shell.leading`; `conversation`, `details`, `ILayout.openDetails/closeDetails`, and the `SessionProvider` owner prop are gone. The Session Controller no longer publishes a current selection: `SessionListState.current`, `ISessions.open`, and `SessionSummary.completed` are gone, and the Conversation is whichever session `ui-workspace` retains under the `mainView` source. On that base the sidebar row threw at load, the console had no sidebar, and the shell declared slots nothing registers into.

## Decision

**The workbench/workflow menu is three volatile fields of the server-sidebar row's own Config.** `workflows`, `groups`, and `workbenchSessionId` are declared `.volatile()` on the row, and the server-menu route writes a patch with `ctx.settings.update(<entry id>, fields)`, the same shape `speech-to-text` uses for its own preferences. The route resolves each patched field through its schema and checks the merged menu with `validateServerMenu` before the write; the row checks the committed menu again at load. The row registers `configure({ auto: false })`, because the sidebar is the fields' editor and a generated page would be a second, unvalidated one. The entry id stays `server-sidebar`: the settings service imports each section of an earlier release's `settings.yaml` into the entry of the same id, so a menu stored under that section reaches the row without a product importer. The invariant companion is removed — it watched `settings/updated`, which no longer exists, and the committed value is Loader Config with no second observation to diverge from.

**The shell declares the shipped children and keeps its own `content` seat.** `server-layout` still replaces `ui-layout`'s root registration. The chat column renders `main` at the key the selected panel names (`conversation` by default); the right column hands `rightbar` its owner share (`width` is the fixed 360px details width) and reserves the details track while the occupant reports one through `openRightbar(true, …)`; `shell.leading` is declared and never mounted, because this shell never hides the session column. The root effect creates the one panel-store instance the frame renders against, binds the `ILayout` face (`panelInfo`, `selectPanel`, `beginNavigation`, `toggleSidebar`, `openRightbar`, `closeRightbar`) to its actions, provides `usePanelInfo` as a root standard hook, and clears a selection whose `main` entry unregisters — the same wiring `ui-layout` uses, so `ui-workspace`, `ui-conversation`, and `ui-sidebar-right` register unchanged.

**The session on screen is the `mainView` row.** Every read of the old `current` reads the row whose `retainedBy.mainView` count is positive, the same expression upstream's own consumers use; every `sessions.open(id)` is `ctx.uiWorkspace.openSession(id)`, which also aborts a pending navigation through `ILayout.selectPanel`. The green dot reads `completionUnread` from `useSessionStatus`.

**Vue 2's global JSX types stay out of the Client aggregate.** `vue/types/jsx.d.ts` adds Vue's `ref` to the global `JSX.IntrinsicAttributes`, which broke four upstream React `ref` props once the Vue packages' specs shared the aggregate. The specs that reach Vue 2 declarations (all of `component-kit` and `vue2-echarts-poc`, two of `component-surface`) typecheck in `tsconfig.vue2-tests.json`, a face-specific leaf referenced from `tsconfig.client.json`, which excludes them — the same shape as `tsconfig.desktop-keyboard-tests.json`.

**The three content commands declare `engages: false`.** The base's Session list now clears `blank` on any `command/run` that does not declare `engages: false`, where the console line cleared it only on `turn/start`. `show-content-page`, `content-navigated`, and `show-content-view` arrange the content column and add no turn, so each declares `engages: false`: a workbench draft that has only shown pages or views stays blank, a second workbench click reuses it, and the temporary group does not list it.

## Alternatives considered

**A product importer that copies the menu out of `settings.yaml` into its own store.** The settings service already imports each section into the entry of the same id; a second importer would own a file the base retired and a persistence path the settings README tells plugins not to own.

**Menu fields as one nested volatile object.** A single `menu` field would let one schema transform check cross-field constraints on resolution, but the imported `settings.yaml` section carries the three fields at the top level, so the import would refuse it.

**Keeping the invariant companion on `loader/volatile-update`.** A companion is a separate plugin with no handle on the row's Config, and re-running `validateServerMenu` over the value the route just validated is the check the package-invariant rule rejects.

**Patching `ui-layout` to keep `conversation`/`details`.** The base removed them in favor of `main` and `rightbar`; restoring them in core would be a permanent patch against a direction upstream chose, while the shell can occupy the new slots from its own package.

**Keeping Vue specs in the aggregate and adjusting the four upstream specs.** The four `ref` props are correct React; the fault is a global declaration from a package the React program should not see.

## Consequences

The console boots with its sidebar again, and the menu survives restarts in the profile patch rather than in a side file. A menu hand-edited into the profile patch that breaks a cross-element constraint fails the row at load rather than at the next write. A section `settings.yaml` stored in the pre-view `navSnapshot` string form is refused by the import and left in `settings.yaml.imported`; converting that file with `convert-nav-snapshot` and renaming it back makes the next start import it again, together with every other section it holds.

The right column is root-scoped now, so a session switch no longer remounts it; its occupant binds its own sessions. `details` held tool details under the old base; `rightbar` is whatever `ui-sidebar-right` renders.

The old base's restated `recentWorkspace` stays in `session-resolution.ts`; the [alpha-5 note](2026-09-03-server-console-on-the-alpha-5-base.md) owns why.
