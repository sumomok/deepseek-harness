---
description: "Compose the customer console over the Web profile as one bundle layer, plus the permission lock a deployment applies above the profile patch."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-console-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-console-profile` turns a `web` profile into the customer console. Its bundle layer swaps in the service shell and the product sidebar, disables the shipped surfaces that show internal vocabulary or developer tools, and mounts the bundled library skills. Its second file, `permission-lock.patch.yml`, pins the console's access presets in a layer above the profile patch. The split follows one rule: the sidebar menu must be saved by the settings service, and the pinned preset must not be.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

From this repository checkout, add the bundle to the `web` profile, then start the profile with the lock overlay:

```sh
pnpm dsh plugin --profile web add ./packages/experimental/console-profile
pnpm dsh --profile web --patch ./packages/experimental/console-profile/permission-lock.patch.yml
```

`dsh plugin add` links the package and appends it to `dsh.profile.bundles` after `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`. The lock may instead be the home patch, `$DSH_HOME/cordis.patch.yml`; both layers compose above the profile patch.

### Add the deployment's own rows

The bundle does not compose the page catalog (`content-frame`), the view catalog (`component-surface`), or the sign-on gate (`auth-gate`); each carries deployment-specific configuration. Put those rows in a local bundle of the deployment's own — a directory holding `cordis.patch.yml` and a `package.json` that declares `"dsh": { "bundle": { "patch": "cordis.patch.yml" } }` and lists each inserted package under `dependencies` — and add it with `dsh plugin --profile web add <dir>`, so it stacks after this one. A row that a settings page saves must not be inserted or configured by `--patch` or the home patch; a row nobody may change belongs there.

### What you get

The console bundle composes these changes over the shipped Web profile:

| Row | Change |
|---|---|
| `server-layout`, `content-surface`, `content-column` | Inserted: the four-track service shell and its content column |
| `server-sidebar` | Inserted with `displayNameClaim: login_uname`; its menu is saved into the profile patch |
| `library-skills` | Inserted: an isolated `skill-filesystem` provider over `@deepseek-ai/dsh-experimental-library-skills` |
| `ui-layout`, `ui-sidebar` | Disabled: their single slots are taken by the shell and the sidebar |
| `ui-agent-preset`, `ui-brand-official`, `ui-cordis`, `ui-trajectory`, `ui-model-selection`, `session-log-download`, `ui-settings-models`, `ui-permission` | Disabled: internal vocabulary, official branding, and developer surfaces |

The lock overlay restates the `permission` row: three presets with customer-facing names, `defaultPreset: workspace-write`, and `isolate: { commands: true }`, which keeps `/permission` unregistered.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The layer order decides which file each row belongs in. A bundle layer composes below the profile patch, and `dsh-config-editor` writes a row's configuration into that profile patch only when the resulting effective configuration equals the value it wrote. A row a `--patch` overlay or the home patch inserts or configures outranks the write, and the editor refuses it. The sidebar's `workflows`, `groups`, and `workbenchSessionId` are volatile Config the sidebar saves, so the row must sit in the bundle layer. `permission.defaultPreset` is also volatile Config, and the `remote.settings` method answers any browser the deployment admits, so the `permission` row must sit above the profile patch.

Disable rows address shipped entries by id alone. A bundle's plugin rows resolve through the bundle's own `dependencies`, which `scripts/verify-cordis-config.ts` enforces, and a disable row loads nothing.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle layer: shell, sidebar, library skills, and every disable row |
| [`permission-lock.patch.yml`](permission-lock.patch.yml) | The `permission` row, applied above the profile patch |
| [`src/index.ts`](src/index.ts) | Empty module entry; the two patch files are the runtime content |
| — | No runtime invariant companion is published; the package owns no mutable relationship. Loader and the profile's patch files own the composition. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and release exclusion.
- [Product console sidebar](../server-sidebar/README.md) — the sidebar the bundle inserts, its menu fields, and the de-terminology rules.
- [Profile bundles](../../bundle/README.md) — how `dsh --profile` stacks installable layers.
- [Config editor](../../boot/config-editor/README.md) — which layer a settings write lands in, and when it is refused.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the rows it composes: the `library-skills` row adds the bundled skills to the skill catalog, and every other composed plugin owns its own model-visible contribution.

#### KV Cache effect

None beyond the composed plugins' own; the skill catalog is prefix-stable while the shipped skill set is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The lock is a launch argument.** A deployment that starts the profile without `--patch permission-lock.patch.yml` and without the home patch gets the shipped preset names, `/permission` in the slash menu, and a `defaultPreset` any settings write can change.
- **The `console` Agent preset is not part of this package.** The console runs the shipped `standard` preset unless the deployment composes its own.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`permission-lock.patch.yml` is published through the `packageFileExtras` table in `scripts/check-workspace-constraints.ts`.

</details>
