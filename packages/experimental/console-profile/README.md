---
description: "Compose the customer console over the Web profile as one bundle layer, plus the permission lock a deployment applies above the profile patch."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-console-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-console-profile` turns a `web` profile into the customer console. Its bundle layer swaps in the service shell and the product sidebar, disables the shipped surfaces that show internal vocabulary or developer tools, mounts the library skills, compacts conversations at 60% of the context window, declares the `console` Agent preset, and disables every shipped Agent preset. Its second file, `permission-lock.patch.yml`, pins the console's access presets and makes `console` the default Agent preset, in a layer above the profile patch. The split follows one rule: the sidebar menu must be saved by the settings service, and the pinned presets must not be.

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
| `console-mcp` | Inserted with `servers: []`: the MCP capability, idle until a deployment names a server |
| `library-skills` | Inserted: an isolated `skill-filesystem` provider over `@deepseek-ai/dsh-experimental-library-skills` |
| `page-refresh` | Inserted with its default config stated: an open page reloads once when its server comes back with a different build, and a banner reports a lost connection; see [`dsh-experimental-page-refresh`](../page-refresh/README.md) |
| `client-hmr` | Disabled: an open page takes no new plugin bundles into the shell it already runs. A plugin bundle rebuilt by `pnpm run dev:web` reaches no console page, open or newly loaded, until the host restarts; a rebuilt shell is served on the next load, and an open page's next build check reloads it onto that shell with the old plugin bundles |
| `ui-layout`, `ui-sidebar` | Disabled: their single slots are taken by the shell and the sidebar |
| `ui-agent-preset`, `ui-brand-official`, `ui-cordis`, `ui-trajectory`, `ui-model-selection`, `session-log-download`, `ui-settings-models`, `ui-permission`, `ui-settings-session-log` | Disabled: internal vocabulary, official branding, and developer surfaces |
| `ui-settings-plugins`, `ui-settings-plugin-inventory` | Disabled: Settings → Plugins, both tabs; the settings shell `ui-settings-general` stays |
| `ui-chat` | Configured with `performanceUsage: compact`: Settings → General → Performance & usage starts at compact, so a completed answer shows no per-Turn token usage; a user's own choice is saved into the profile patch and outranks this default. Its "Compaction while busy" row is withheld by `server-sidebar`, and `busyCompaction` keeps its default, `turn-end` |
| `auto-compact` | Inserted from the vendored `vendor/haoran-dsh-auto-compact-0.5.1.tgz` with `enabled: true` and `thresholdPercent: 60`: between two steps of a turn, once the next model request would take more than 60% of the context window, the conversation is compacted before that request. The plugin reaches the compaction engine inside the `console` preset and its `standard` twin. Its Settings → General row is withheld by `server-sidebar`; a compaction in progress still shows its row in the conversation |
| `preset-console` | Inserted: the `console` Agent preset — persona, `tool-fs`, `skill-filesystem`, `tool-skill`, the compaction group, `tool-ask-user`, and `tool-todo`; no shell, search, job, goal, plan, delegation, web, or `present` row |
| `preset-standard-as-console` | Inserted: a `standard` Agent preset with exactly `console`'s plugins; a session resumes under the preset id it was created with, and sessions a console deployment created before `console` existed carry `standard` |
| `preset-standard`, `preset-ptc`, `preset-minimal`, `preset-cordis` | Disabled: they carry the shell and the other developer rows, `cordis` also mounts `tool-cordis` and a skill that lists every workspace package, and `session.create` accepts an `agentPreset` over RPC, so hiding the picker is not enough; every session runs `console`'s plugins, under the id `console` or `standard` |

The lock overlay restates three rows. The `permission` row carries three presets with customer-facing names, `defaultPreset: workspace-write`, and `isolate: { commands: true }`, which keeps `/permission` unregistered. The `agent-preset-registry` row carries `default: console` and no `selectedDefault`, so every new session runs the `console` preset. The `session-log-deepseek` row carries `enabled: false`, so no session uploads its Session log to the official model API.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The layer order decides which file each row belongs in. A bundle layer composes below the profile patch, and `dsh-config-editor` writes a row's configuration into that profile patch only when the resulting effective configuration equals the value it wrote. A row a `--patch` overlay or the home patch inserts or configures outranks the write, and the editor refuses it. The sidebar's `workflows`, `groups`, and `workbenchSessionId` are volatile Config the sidebar saves, so the row must sit in the bundle layer. `permission.defaultPreset`, `agent-preset-registry.selectedDefault`, and `session-log-deepseek.enabled` are also volatile Config, and the `remote.settings` method answers any browser the deployment admits, so these three rows must sit above the profile patch. A stored `selectedDefault` naming a preset the console does not declare would fail every new session with `agent-preset/not-found`.

Disable rows address shipped entries by id alone. A bundle's plugin rows resolve through the bundle's own `dependencies`, which `scripts/verify-cordis-config.ts` enforces, and a disable row loads nothing.

The vendored tarball declares its harness packages as optional peers. `@deepseek-ai/schemastery` is a runtime import of the plugin, so it is under `dependencies`; the type-only peers are under `devDependencies`. With them declared, the workspace install links each peer to the workspace copy; without them, pnpm resolves the missing peers from the registry and installs a second set of harness packages.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle layer: shell, sidebar, the page's build check, MCP capability, library skills, automatic compaction, the `console` Agent preset, and every disable row |
| `vendor/haoran-dsh-auto-compact-0.5.1.tgz` | `@haoran/dsh-auto-compact` 0.5.1 from the out-of-repo plugin repository, packed from a build of its pushed `main` and declared as `"@haoran/dsh-auto-compact": "file:./vendor/haoran-dsh-auto-compact-0.5.1.tgz"` |
| [`permission-lock.patch.yml`](permission-lock.patch.yml) | The `permission`, `agent-preset-registry`, and `session-log-deepseek` rows, applied above the profile patch |
| [`src/index.ts`](src/index.ts) | Empty module entry; the two patch files are the runtime content |
| — | No runtime invariant companion is published; the package owns no mutable relationship. Loader and the profile's patch files own the composition. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and release exclusion.
- [Product console sidebar](../server-sidebar/README.md) — the sidebar the bundle inserts, its menu fields, and the de-terminology rules.
- [Page refresh](../page-refresh/README.md) — the build check and connection banner the bundle inserts, and why live plugin replacement is off.
- [Profile bundles](../../bundle/README.md) — how `dsh --profile` stacks installable layers.
- [Config editor](../../boot/config-editor/README.md) — which layer a settings write lands in, and when it is refused.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the rows it composes. The `console` Agent preset decides the session's own tools: `read`, `write`, `edit`, `read_image`, `skill`, `ask_user_question`, and `todo_write`, beside the host plane's content-column tools, and its persona prefix is the customer assistant's instruction: show the data the user asks about through components, describe no working directory, tool, or internal implementation, and name tables, fields, layers, entries, and categories by their Chinese display names rather than by table names, entry ids, codes, or enum values; everything a user sees is written in Chinese, the opening sentence and the reasoning included, since the conversation's process rows show the reasoning. The `auto-compact` row decides when the model's history is condensed: from the step after a request would take more than 60% of the context window, the model reads long tool results cut to their start and end and, when that is not enough, a summary of the older history. The `console-mcp` row offers each configured server's tools as `mcp__<server id>__<tool>` and nothing while its list is empty. The `library-skills` row adds the bundled skills to the skill catalog, disabling the four shipped presets removes every other tool set a session could run under, and every other composed plugin owns its own model-visible contribution.

#### KV Cache effect

None beyond the composed plugins' own; the skill catalog is prefix-stable while the shipped skill set is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The lock is a launch argument.** A deployment that starts the profile without `--patch permission-lock.patch.yml` and without the home patch gets the shipped preset names, `/permission` in the slash menu, a `defaultPreset` any settings write can change, and a Session-log upload one settings write away from on. Its Agent-preset default is the Web bundle's `standard`, which this bundle disables, so every new session fails with `agent-preset/not-found`.
- **The MCP server list is deployment Config, not a setting.** `console-mcp.servers` sits in the bundle layer like the sidebar's menu, but it is not a `.volatile()` field: the settings service projects no form for it and refuses a write with `Plugin entry "console-mcp" has no volatile fields`, so no browser the deployment admits can add a server. A deployment names its servers by patching the row's `config` in its own layer, and a changed list takes effect when the row reloads. A bridged MCP tool declares no approval gate, so it runs under every access preset, under the credential the row's `auth` names.
- **The two withheld compaction settings are still writable.** `auto-compact.enabled`, `auto-compact.thresholdPercent`, and `ui-chat.busyCompaction` are volatile Config in the bundle layer, so the page offers no control for them while the `remote.settings` method still accepts a write from any browser the deployment admits.
- **The `console` preset keeps the file tools.** `tool-fs` lets the agent write the skills it distils into `<workspace>/.dsh/skills`, and it also lets it write any other file the `permission` preset's sandbox admits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`permission-lock.patch.yml` is published through the `packageFileExtras` table in `scripts/check-workspace-constraints.ts`.

To replace the vendored `@haoran/dsh-auto-compact`, build the plugin from a clean copy of a pushed commit of its repository, not from a working checkout whose `lib/` may be older than its sources, run `pnpm pack`, put the tarball under `vendor/`, update the `file:` specifier, `tests/profile.spec.ts`, and the archive path in `OVERRIDES` of `scripts/gen-third-party-notices.ts`, and run `pnpm install`. The e2e harness links the unpacked copy under `node_modules/@haoran/dsh-auto-compact` into its profile (`apps/web/tests/server-sidebar.e2e.ts`).

</details>
