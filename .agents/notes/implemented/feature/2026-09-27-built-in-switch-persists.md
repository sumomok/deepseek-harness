# Agent Note: A built-in plugin switched off stays off

Status: implemented

English | [中文](2026-09-27-built-in-switch-persists.zh.md)

## Problem

The desktop shell links thirteen built-in plugins into `$DSH_HOME/profiles/node_modules` and lists them in `dsh.profile.bundles` of the `desktop-shell` profile. The Plugins page switches a bundle off by removing its name from that list. On the next launch, [`seedExistingManifest`](../../../../apps/desktop-shell/src/profile-seed.ts) found the name missing, treated it as a plugin a new build adds, and inserted it again. A person's switch lasted until the next launch.

A missing name has two causes that the bundle list alone cannot tell apart: a build added the plugin, or the person switched it off. The launch needs a record of which built-ins it has already put into the profile.

## Decision

The record is `dsh.profile.shipped` in the profile manifest: the payload's built-in plugins, without the composition layer `@deepseek-ai/dsh-desktop-app`. Every launch rewrites it to this payload's list. A built-in missing from `dsh.profile.bundles` is added back only when the record read at the start of the launch does not name it; one the record names is left off and reported as `left switched off built-in <name>` in `dsh-server.log`. The flat-fallback link is kept for an off built-in, so a new payload version reaches it while it is off, and the Plugins page reads its version and rows through it. The composition layer is not in the record and is always added back.

The same field is what the core patch `launcher-shipped-bundles` reads, so the Plugins page lists every built-in, on or off, with a Built-in tag and no uninstall.

Migration: a profile seeded by an earlier build has no record. Its missing built-ins are added back, as every earlier launch did, and the record is written. No earlier build could keep a built-in off, so no person's choice is lost.

## Alternatives considered

**Record the choice in `web-migration.json`.** Rejected. That file records what the `web` profile sync did, the Host does not read it, and the Plugins page would still have no source for an off built-in. A second list would also need to stay consistent with the manifest.

**Record switched-off names instead of shipped names.** Rejected. The Plugins page writes only `dsh.profile.bundles`; the shell would have to infer the switch from a missing name anyway, and the Host would still need the shipped list to show the off bundle.

**Disable the bundle's rows in the profile patch layer.** Rejected. The Plugins page's bundle switch does not write rows, and a row disable leaves the bundle layer mounted.

## Testing

| Evidence | Behaviour |
|---|---|
| [profile-seed.spec.ts](../../../../apps/desktop-shell/tests/profile-seed.spec.ts) | A switched-off built-in stays out across two launches and stays recorded and linked; a new payload version re-points its link and keeps it off; switched back on it stays on and the composition layer moves after it; a name the record lacks is still added; the composition layer is always added back; a profile without a record gets one without a bundle list change; a malformed record is replaced. Always adding missing names back, or not writing the record, fails these cases. |

## Consequences

- A built-in switched back on runs after the composition layer until the next launch reorders the list.
- A built-in that one build does not carry drops out of the record, and the next build that carries it adds it back switched on.
- Until `launcher-shipped-bundles` reaches `develop`, the record has no reader and the Plugins page shows no built-in card.
