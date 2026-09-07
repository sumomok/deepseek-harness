# Agent Note: the customer console offers no permission switch

Status: implemented

English | [中文](2026-09-07-console-no-permission-switch.zh.md)

## Problem

The customer console had been hiding one of three permission controls and leaving the other two live.

`terminology-guard.ts` hid the composer's access chip in CSS, because its "Workspace Write" label is title-cased from a preset's machine name and no locale entry or disable row reaches it. That closed the surface the guard could see. It did not close `/permission`, which `@deepseek-ai/dsh-permission-presets` registers whenever a command registry is composed, and which the console's slash menu listed for every visitor alongside `compact` and `feedback`. It did not close the Settings → General default-preset row either — `@deepseek-ai/dsh-client-ui-permission-presets`' own registration, which writes `permission.defaultPreset` for later sessions and outranks the composed default through the Settings seam.

So a customer-form deployment shipped a page whose access chip was invisible and whose two write paths to the same knob were one click and one typed line away, including the path to full access. The product decision (2026-09-07) is that a console offers an end user no permission switch of any kind.

## Decision

**All three surfaces are closed, each by the cheapest mechanism that reaches it.** The chip stays CSS-hidden (unchanged). The Settings row is disabled outright, as an ordinary overlay row. `/permission` is kept from ever being registered by isolating the service it registers through.

**`isolate: { commands: true }` on the `permission` row.** The vendored loader accepts a per-entry `isolate` map (`vendor/loader/src/config/isolate.ts:5-14`) and, on `loader/patch-context`, replaces the entry's isolate map with a fresh realm symbol per isolated name (`:96-100`). `isolate: true` mints an entry-local realm nothing provides into, so `ctx.inject(['commands'], …)` at `packages/interaction/permission-presets/src/index.ts:269` never activates and the command is never registered: `commands.list` never names it, and the slash menu — which has no filter seam of its own — has nothing to filter. The plugin still loads unconditionally, and nothing else on the row is isolated, so the preset table, the `permissions` projection, the Settings section the package installs, and enforcement itself are untouched. The key is already accepted as literal entry metadata by `scripts/verify-cordis-config.ts:39` and is already used by shipped configs (`packages/preset/agent-presets/presets/standard/agent.cordis.yml`, `apps/cli/config/examples/github-review/cordis.yml`).

**Isolation is per entry, which is the whole reason it can be used here.** The registry itself has to stay: `@deepseek-ai/dsh-commands` is composed by `packages/bundle/base/cordis.patch.yml` and the console depends on it on both planes — the content column's switcher strip dispatches `dismiss-content-entry`/`select-content-entry`, the sidebar's navigation rows dispatch `show-content-page`/`show-content-view`, `show_component`'s press return path goes browser → host through it, and `SessionFace.command()` is the generic command send. Every one of them keeps the registry the base bundle composes; only this one entry sees a realm where the name resolves to nothing.

**`defaultPreset: workspace-write` is stated rather than derived.** With no `defaultPreset`, `PermissionPresetService` folds the composed sandbox and approval defaults against the table in declaration order (`src/index.ts:207-211, 327-338`). `packages/bundle/base/cordis.patch.yml:220-239` derives both knobs from one `DSH_PERMISSION_MODE` expression whose unset default is `workspace-write` + `ask`, and the console overlay's table has exactly one row with that pair — so `workspace-write` is what a console pins today, and writing it changes nothing this deployment does. What it buys is that the preset stops depending on an environment variable no console sets, now that no browser path can write `permission/preset` again: config states it, `pinInitialPermission` (`src/index.ts:423-435`) stamps it onto every new session, and the chip's `aria-label` is the only place it is still read.

**The residue is a typed line, and it is accepted.** `/permission read-only` still submits. Observed in the running browser lane: with no host descriptor and no client contribution under that name, `matchEnter` resolves nothing (`packages/client/ui-commands/src/client/service.ts:343-344`), the trigger's Enter adjudication returns `undefined` (`ui-input-trigger/src/client/controller.ts:319-329`), and the composer's default sink submits the line as ordinary text. It lands on the log as a `user/message` whose content is the literal `/permission read-only`, opens a turn, and reaches the model as those two words. No `permission/preset` event is appended and the access chip's `aria-label` still names the pinned preset. Nothing in the UI acknowledges the string.

**How a server deployment should control permission is a separate, pending item.** This change closes the end-user surfaces and pins the deployment's preset; it does not design the operator-facing control.

## Alternatives considered

**Filter the row out on the client.** There is no seam. `CommandUiContract` is add-only: `register` adds a client row and throws on a host-name collision (`packages/client/ui-commands/src/client/service.ts:260-262`), `decorate` explicitly cannot manufacture or remove a row (`src/client/contract.ts:69-72`), `candidates()` has no hook, and the host's `list()` is a plain `@Remote` method returning a frozen sorted array — no waterfall, no veto, and `CommandDescriptor` carries no visibility bit.

**Hide the row in CSS, the way the chip is hidden.** The chip trick does not repeat. `MenuView.tsx:133-137` renders each option with an id built from the group name and a positional index that shifts with every query; there is no `data-name`, no per-command class, and no text-matching selector. Shadowing the whole `conversation.input.overlay`/`slash-menu` slot is technically reachable but `MenuView` is not exported and its CSS module is private, so it would mean re-implementing an upstream component and its styling inside `packages/experimental`.

**Drop the `commands` registry from the console composition.** It breaks the switcher strip's tabs, the sidebar's navigation, every component-surface button press, and the generic command send. Four consumers, all of them ours.

**Scope-shadow `permission` from a console-owned agent preset.** `ScopedLayers.merge` (`packages/core/scope/src/store.ts:208-217`) lets a plugin mounted under an agent's ctx win the name, replacing the handler and the description. It cannot delete the row — `list()` returns the merged view, which still holds exactly one `permission` descriptor — so the menu would still offer it. It also needs a console-owned agent preset, which is more machinery than one YAML key.

**Add a config flag to `permission-presets`.** Its `Config` is exactly `presets` and `defaultPreset` (`src/index.ts:156-190`); a suppress-the-command flag would be an upstream change, which this fork's standing rule forbids where a composition-level answer exists.

**Trim the overlay's preset table to the single preset the console ships.** It would make the pinned preset self-evident and shrink what the label-drift guard has to cover, but it throws away the table a later operator-facing control would configure, for no user-visible gain while nothing renders the other two names.

## Consequences

- The console's slash menu lists eight commands and `permission` is not one of them; the Settings → General panel has no permission row; the access chip is present, hidden, and pinned to `可修改文件`.
- A visitor who types `/permission` gets no menu rows and no refusal — the line goes to the model as text (see the residue above, and the package README's Known Limitations).
- `DSH_PERMISSION_MODE` no longer moves a console's default preset. It still moves the composed sandbox and approval knobs, so a deployment that sets it to anything but `workspace-write` now composes a mismatch the pinned preset overrides per session rather than a silently different default. No console sets it.
- The three console overlays under `apps/web/tests/` are copies of the shipped row rather than includes (`extraOverlayPath` takes exactly one path), so drift between them is possible; `packages/experimental/server-sidebar/tests/customer-overlay.client.spec.ts` compares each copy against the shipped row.
- Nothing model-visible changed: `commands.list` is a Remote method that reaches no model, and the runtime-context message still reports `workspace-write` + `ask`.

## Testing

`packages/experimental/server-sidebar/tests/customer-overlay.client.spec.ts` parses the shipped overlay with `js-yaml` and the loader's entry schema (the pattern `packages/experimental/content-frame/tests/permission-gateway-overlay.client.spec.ts` established) and pins the closed set the e2e used to guard: the three preset ids in table order, their customer-facing names, `isolate.commands === true`, a `defaultPreset` naming one of them, and the `ui-permission` disable row — then asserts the three `apps/web/tests/` overlays carry both rows identically.

`apps/web/tests/server-sidebar.e2e.ts`'s preset scenario became unreachable and is replaced by one that reads all three surfaces in the assembled browser: a bare `/` in the composer lists the console's whole command set (`compact`, `content-navigated`, `dismiss-content-entry`, `feedback`, `goal`, `plan`, `select-content-entry`, `show-content-page`), so a command this composition gains fails it too; Settings → General renders one of its shipped rows and no permission row; and the chip is present-and-invisible through the existing `expectGuardHides` helper, on the pinned preset's name. The scenario was checked against a deliberately broken build: with the `isolate` key removed from the e2e overlay, the menu lists nine rows and the case fails on the extra `permission`.

`examples/content-console` is the console's keyless snapshot lane and needs nothing here: it composes the backend spine only, never applies `overlay/customer.patch.yml`, and does not compose `permission-presets` at all — its own module doc records that the browser rows' evidence is the Playwright lane under `apps/web/tests`. This change is confined to that overlay and to browser-visible surfaces, so it moves no transcript.
