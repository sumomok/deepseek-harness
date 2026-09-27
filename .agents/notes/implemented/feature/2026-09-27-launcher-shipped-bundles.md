# Agent Note: The plugin manager lists launcher-shipped bundles

Status: implemented

English | [中文](2026-09-27-launcher-shipped-bundles.zh.md)

## Problem

An application that launches a profile can supply bundles from its own payload: it links each package into the flat fallback `$DSH_HOME/profiles/node_modules` and names it in `dsh.profile.bundles`, without a profile dependency. [`listBundles`](../../../../packages/boot/plugin-manager/src/index.ts) reads its names from `dsh.profile.bundles`, the profile's `dependencies`, and the installation's `dependencies`, and reports such a bundle as `installed: false, optional: false`. The Plugins page admits only installed, optional, or failed bundles, so these bundles had no card, no switch, and no row switches. Switching one off through `setBundleEnabled` removes its name from `dsh.profile.bundles`, after which none of the three sources names it and the Host stops listing it, so no page could offer to switch it back on.

A migrated `web`-profile plugin that a launcher links in has the same `installed: false, optional: false` fields, and so does a launcher's own composition layer. The page therefore cannot identify a launcher-supplied plugin from those two fields.

## Decision

The launcher states the fact in the profile manifest. `DshProfileManifest.shipped` is a list of bundle names the launching application supplies from its payload; the launcher writes it and nothing in DSH writes it. `listBundles` adds these names to the names it reads and reports `BundleInfo.shipped: true` for each one. A shipped bundle is listed whether or not `dsh.profile.bundles` selects it; a shipped name whose package is missing or has no bundle patch is listed with its problem. `setBundleEnabled` spreads `dsh.profile`, so switching a bundle off leaves the list unchanged. A `dsh.profile.shipped` that is not an array of strings is read as no names and logged once per distinct value; a string would otherwise list one entry per character, and an object would fail the whole read. `removable` is unchanged: a shipped bundle is removable only when the profile's own dependencies also hold a copy.

The Plugins page admits `shipped` bundles into **Installed** with a **Built-in** tag on the card and the page. Grouping and the absent uninstall follow from the existing rules: the bundle is not `optional`, and uninstall is offered only for `installed`. A launcher leaves its composition layer and migrated user plugins out of `shipped`, so they stay off the page as before.

## Alternatives considered

**Admit every enabled, not installed, not optional bundle in the page filter.** Rejected. It tags migrated user plugins and the composition layer as built-in, and a bundle disappears from the page as soon as it is switched off.

**List every bundle resolvable through the flat fallback.** Rejected. That directory also holds the CLI application's dependency closure, so the list would depend on how the installation was linked rather than on what the launcher ships.

**Keep the shipped list in launcher-owned storage outside the manifest.** Rejected. The Host would need a second input to read, and the list and `dsh.profile.bundles` could fall out of step.

## Testing

| Evidence | Behaviour |
|---|---|
| [manager.spec.ts](../../../../packages/boot/plugin-manager/tests/manager.spec.ts) | A shipped bundle is listed switched off with its version and rows, a patchless and a missing shipped package are listed with their problems, switching it on and off keeps `dsh.profile.shipped`, and removal is refused. Dropping the shipped names from the name set, or from either guarded push, fails this case. A string, an object, and a mixed array are each read as no names with one warning across two reads; accepting them, warning on every read, or not warning fails these cases. |
| [components.client.spec.tsx](../../../../packages/client/ui-plugin-manager/tests/components.client.spec.tsx) | Shipped bundles appear under **Installed**, on and off, each with the **Built-in** tag; an unshipped selected layer stays off the page; the page carries the tag and version and no uninstall. Removing `shipped` from the page filter fails this case. |

## Consequences

- A launcher that ships bundles must write `dsh.profile.shipped` and keep it current, including removing a name it stops shipping.
- A launcher that re-adds a missing name to `dsh.profile.bundles` on every start overrides the person's switch; honoring the switch is the launcher's responsibility.
- `setBundleEnabled(name, true)` appends the name to the end of `dsh.profile.bundles`. A launcher that orders its layers must restore that order on its next start.
- `list_bundles` results now carry `shipped`.
