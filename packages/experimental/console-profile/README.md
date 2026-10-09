---
description: "Compose the customer console over the Web profile as one bundle layer, plus the permission lock a deployment applies above the profile patch."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-console-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-console-profile` turns a `web` profile into the customer console. Its bundle layer swaps in the service shell and the product sidebar, disables shipped surfaces and prompt sections carrying internal vocabulary, developer tooling, or Host administration, mounts the library skills, compacts conversations at 60% of the context window, declares the `console` Agent preset, and disables every shipped one. Its second file, `permission-lock.patch.yml`, pins the access presets, the model, the `console` default preset, and every shared preference above the profile patch. The split follows one rule: the settings service must save the sidebar menu, and must not save the pinned rows.

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
| `content-point` | Inserted with no config: the 「指一下」 button beside the composer's 「+」 points at a place in the content column or the sidebar and files it as a reference; before the step the message enters, the row appends one logged message writing each point's key line and display text; see [`dsh-experimental-content-point`](../content-point/README.md) |
| `client-hmr` | Disabled: an open page takes no new plugin bundles into the shell it already runs. A plugin bundle rebuilt by `pnpm run dev:web` reaches no console page, open or newly loaded, until the host restarts; a rebuilt shell is served on the next load, and an open page's next build check reloads it onto that shell with the old plugin bundles |
| `web-runtime` | Configured with `surfaceContext: false`, its other four fields restating the Web bundle's values: no model request carries the `harness:source` section (the path of the DeepSeek Harness checkout) or the `app:web-surface` section (the page's local URL and `pnpm run dev:web`), and no shell command gets `DSH_WEB_URL`, which only the `bash` and `pwsh` tools read and neither console preset offers |
| `ui-deliverables` | Disabled: its prompt section, which tells the model when to call `present`, a tool neither console preset offers, leaves every model request, and with it the changed-files card (drawn only with Coding Tools on), delivery cards, clickable file paths in a closing answer, and the review tab they open |
| `system-prompt` | Configured with `includeHarnessIdentity: false`, its `personaPrefix` and `personaSuffix` restating the Web bundle's values: no model request opens with `You are an AI agent powered by DeepSeek Harness.`, a sentence the assistant otherwise repeats to a customer who asks what runs it |
| `ui-layout`, `ui-sidebar` | Disabled: their single slots are taken by the shell and the sidebar |
| `ui-agent-preset`, `ui-brand-official`, `ui-cordis`, `ui-trajectory`, `ui-model-selection`, `session-log-download`, `ui-settings-models`, `ui-permission`, `ui-settings-session-log` | Disabled: internal vocabulary, official branding, and developer surfaces |
| `ui-settings-plugins`, `ui-settings-plugin-inventory` | Disabled: the Settings → Plugins section and its one tab, the Loader inventory. The settings shell `ui-settings-general` stays |
| `plugin-manager`, `plugin-inventory`, `ui-plugin-manager`, `ui-settings-shell`, `ui-settings-agent-loop`, `ui-settings-subagent`, `ui-settings-web-search` | Disabled: plugin management. Every visitor the login admits is the Host's operator, and `pluginManager.installBundle`, `setBundleEnabled`, and `setPluginEnabled` install a package or switch on a bundle, such as the Inspector, whose CDP target evaluates code in the Host. `plugin-inventory` lists the Loader's rows for the Plugins pages; `ui-plugin-manager` is the sidebar Plugins page, which nothing in the console opens, and its Host half probes two public npm registries; the four configuration pages register only into that page. The `hmr` row that would apply such a change live is disabled below |
| `hmr` | Disabled: `hmr` has no Remote method, but it applies an on-disk profile change without a restart. `tool-fs` under `workspace-write` admits a write outside the session workspace on the one approval the admitted visitor gives, so a write to the profile patch or the home patch would become live code the next profile reload runs. With the row gone, such an edit takes effect only at the next Host restart; `config-editor` still saves and reconciles each settings write without it. This narrows the on-disk-write chain, not the write itself |
| `goal`, `goal-round-driver`, `ui-goal` | Disabled: goals, both halves and the session driver. `goals.create`, `edit`, `resume`, and the rest answer every admitted visitor on the root realm, and `goal-round-driver` runs model turns on the Host's key until a goal's round cap once one is armed. No console preset mounts `tool-goal`, the Web bundle disables `command-goal` and `tool-goal`, and `ui-goal` is the browser half nothing navigates to, so no console feature arms a goal and no composed row waits on the `goals` service |
| `cordis-host-runner`, `cordis-inspect-providers`, `cordis-client-runner` | Disabled: dynamic Cordis packages, both halves. `dynamicCordisRunner.runHostHalf` activates a caller-supplied package whose Host half runs in a `node:vm` realm in the Host process; no console preset mounts `tool-cordis`, and the inspect providers register only into this runner |
| `terminal-controller`, `ui-sidebar-terminal` | Disabled: `terminal.create` spawns a shell with the Host user's permissions, outside the Agent sandbox and with no approval step, and the right sidebar's Terminal tab draws it |
| `ui-sidebar-files` | Disabled: the right sidebar's Files tab, a file tree labelled with the working directory's absolute path on the Host, and its 工作区文件 shortcut. Composed, it is the one tab type the guide offers, so a column opened empty would show it; without it the guide offers nothing to open, and `server-sidebar` withholds the column's toggle key and the conversation header's expand button, so the column opens only on the document tab of a file a visitor clicks. The column and its document tab stay composed. The document tab reads files through the `workspace-files` Remote, whose directory listings and change observations are confined to the working directory, while its file reads follow the composed filesystem's read access, including paths outside the working directory |
| `llm-pi-ai` | Disabled: the only model discovery, which `llm.discoverModels` runs against a caller-supplied URL from the Host, and a volatile `providers` field whose routes carry their own endpoint and credential reference. The row has no provider in the console, whose model runs on `llm-deepseek` |
| `web`, `web-search-deepseek`, `web-fetch-http` | Disabled: no console preset offers `web_search` or `web_fetch`, and the search row's `apiKey`, `apiKeyEnv`, and `baseURL` are volatile Config a settings write reaches |
| `directory-picker`, `open-in-app`, `ui-open-in-app`, `office-to-pdf` | Disabled: `directoryPicker.list` and `directoryPicker.createDirectory` list and create directories anywhere on the Host's filesystem, Open In launches a Host application on a path, and `officeToPdf.render` converts a caller-named Office file with LibreOffice in the Host. The console sidebar offers no add-workspace flow, Open In button, or Office preview |
| `schedule`, `ui-schedule` | Disabled: Schedule, both halves — the Host task store with its `schedule.*` Remote methods, and the Automation tasks page with the card a created reminder draws. Every signed-in visitor shares the console's one Host: `schedule.catalog` returns every session's tasks, and the four `schedule_*` tools change tasks with no approval step. The tools and the `time-context` clock row belong to the shipped `standard`, `ptc`, and `cordis` presets, all disabled; neither console preset declares them, so no preset is left with a `tool-schedule` waiting for the missing service |
| `auto-compact` | Inserted from the vendored `vendor/haoran-dsh-auto-compact-0.5.1.tgz` with no config; the lock holds `enabled: true` and `thresholdPercent: 60`: before each model request of a turn, the first included, the conversation is compacted when the history already recorded takes more than 60% of the context window; before a turn's first request that history ends before the message just sent, which is not counted. The plugin reaches the compaction engine inside the `console` preset and its `standard` twin. Its Settings → General row is withheld by `server-sidebar`; what a compaction draws in the conversation is listed under Known Limitations |
| `preset-console` | Inserted: the `console` Agent preset — persona, `tool-fs`, `skill-filesystem`, `tool-skill`, the compaction group without `command-compact`, `tool-ask-user`, and `tool-todo`; no shell, search, job, goal, plan, delegation, web, or `present` row |
| `preset-standard-as-console` | Inserted: a `standard` Agent preset with exactly `console`'s plugins; a session resumes under the preset id it was created with, and sessions a console deployment created before `console` existed carry `standard` |
| `preset-standard`, `preset-ptc`, `preset-minimal`, `preset-cordis` | Disabled: they carry the shell and the other developer rows, `cordis` also mounts `tool-cordis` and a skill that lists every workspace package, and `session.create` accepts an `agentPreset` over RPC, so hiding the picker is not enough; every session runs `console`'s plugins, under the id `console` or `standard` |

The lock overlay restates sixteen rows. Six pin the access presets, the Agent preset, the Session-log upload, and the model. The `permission` row carries three presets with customer-facing names, `defaultPreset: workspace-write`, and `isolate: { commands: true }`, which keeps `/permission` unregistered. The `agent-preset-registry` row carries `default: console` and no `selectedDefault`, so every new session runs the `console` preset. The `session-log-deepseek` row carries `enabled: false`, so no session uploads its Session log to the official model API. The `llm-deepseek` row carries an empty config, the base bundle's, so no settings write can point the model route at another endpoint or credential reference. The `llm-deepseek-account` row carries the same empty config, so a settings write cannot repoint the account route's `baseURL` or model catalog either. The `agent-default-model` row carries the base bundle's `deepseek-official` and `deepseek-flash`, so `session.selectModel` switches only the one session and logs that the default was not saved. A deployment that configures one of the last three rows in its own layer moves that config into the lock row, which replaces the whole config.

The lock's other ten rows hold what a settings write would otherwise change for every visitor: on the console the Settings page persists to the Host (`dsh-experimental-server-base`'s `ownsHost`), so even the browser-side preferences save into the one profile patch every visitor shares. Each row restates the config the layers below compose and states the rest of its volatile fields at the value the console already ran with; the file names each value's source:

| Row | Held at |
|---|---|
| `bash-sandbox` | `timeoutMs: 60000`, the base bundle's; the other limits keep their defaults. Neither console preset offers a shell tool |
| `agent-loop` | `agents: []`, the base bundle's, and `maxParallelToolCalls: 10` |
| `subagent` | `maxDepth: 1`, `maxActiveSubagents: 8`. Neither console preset delegates |
| `subagent-model-selection-settings` | `enabled: false`, `allowedModels: []` |
| `auto-compact` | `enabled: true`, `thresholdPercent: 60` |
| `locale` | `{}`: each browser shows its own language |
| `ui-theme` | `preference: system`, `fontSize: 14`: each browser follows its own system's light or dark mode |
| `ui-chat` | `performanceUsage: compact` (no per-Turn token usage under a completed answer), `linkOpening: sidebar`, `busyCompaction: turn-end`; `transcriptView` is unset, so the browser's default, `detailed`, applies |
| `ui-conversation` | `busyEnter: queue` |
| `ui-settings` | `enabled: false`: the developer-tools preference is off, so the right sidebar's HTML preview draws a sanitized static copy of the page, runs no script, and reads no related file. Its default is on, so this is the one row whose value changes what a console page did before |

`server-sidebar` withholds every Settings → General row these namespaces draw, so Settings → General shows only the keyboard shortcuts, which each browser stores for itself, and the current version.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The layer order decides which file each row belongs in. A bundle layer composes below the profile patch, and `dsh-config-editor` writes a row's configuration into that profile patch only when the resulting effective configuration equals the value it wrote. A row a `--patch` overlay or the home patch inserts or configures outranks the write, and the editor refuses it. The sidebar's `workflows`, `groups`, and `workbenchSessionId` are volatile Config the sidebar saves, so the row must sit in the bundle layer. `permission.defaultPreset`, `agent-preset-registry.selectedDefault`, `session-log-deepseek.enabled`, the fields of `llm-deepseek`, `llm-deepseek-account`, and `agent-default-model`, and the preferences and tunables of the lock's other ten rows are also volatile Config, and the `remote.settings` method answers any browser the deployment admits, so these sixteen rows must sit above the profile patch. A lock row replaces the row's whole config, so it restates every field the layers below set; a row the lock configures appears in the bundle layer only as an insert with no config, which `tests/profile.spec.ts` checks together with a composition of the lock that raises no warning. The spec also reads each of the ten rows through its plugin's own Config schema and compares the result with the same reading of the layers below, over which it lays the two configs the lock took out of the bundle layer (`auto-compact`'s and `ui-chat`'s `performanceUsage`); `ui-settings.enabled`, held off, is the one value that differs. A stored `selectedDefault` naming a preset the console does not declare would fail every new session with `agent-preset/not-found`.

Disable rows address shipped entries by id alone. A bundle's plugin rows resolve through the bundle's own `dependencies`, which `scripts/verify-cordis-config.ts` enforces, and a disable row loads nothing.

The vendored tarball declares its harness packages as optional peers, and pnpm 11.7.0 does not fetch an optional peer by itself: only a peer this manifest declares is linked beside the plugin, to the workspace copy. `@deepseek-ai/schemastery` is a runtime import of the plugin, so it is under `dependencies`; the type-only peers are under `devDependencies`. Without the declaration, the plugin's runtime import of `@deepseek-ai/schemastery` has no workspace copy linked to it.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle layer: shell, sidebar, the page's build check, MCP capability, library skills, automatic compaction, the `console` Agent preset, and every disable row |
| `vendor/haoran-dsh-auto-compact-0.5.1.tgz` | `@haoran/dsh-auto-compact` 0.5.1 from the out-of-repo plugin repository, packed from a build of its pushed `main` and declared as `"@haoran/dsh-auto-compact": "file:./vendor/haoran-dsh-auto-compact-0.5.1.tgz"` |
| [`permission-lock.patch.yml`](permission-lock.patch.yml) | The `permission`, `agent-preset-registry`, `session-log-deepseek`, `llm-deepseek`, `llm-deepseek-account`, and `agent-default-model` rows, and the ten rows of page preferences and Host tunables, applied above the profile patch |
| [`src/index.ts`](src/index.ts) | Empty module entry; the two patch files are the runtime content |

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

Indirectly, through the rows it composes. The `console` Agent preset decides the session's own tools: `read`, `write`, `edit`, `read_image`, `skill`, `ask_user_question`, and `todo_write`, beside the host plane's content-column tools, and its persona prefix is the customer assistant's instruction: show the data the user asks about through components, describe no working directory, tool, or internal implementation, and name tables, fields, layers, entries, and categories by their Chinese display names rather than by table names, entry ids, codes, or enum values; everything a user sees is written in Chinese, the opening sentence and the reasoning included, since the conversation's process rows show the reasoning. The `auto-compact` row decides when the model's history is condensed: from the first model request before which the recorded history takes more than 60% of the context window, the first request of a turn included (its check does not count the message just sent), the model reads long tool results cut to their start and end and, when that is not enough, a summary of the older history. The `web-runtime` row's `surfaceContext: false` and the disabled `ui-deliverables` row keep three Web-bundle sections out of the prompt: the DeepSeek Harness checkout's path, the Web GUI's local URL with its rebuild instructions, and the guidance on showing results and calling `present`; the `system-prompt` row's `includeHarnessIdentity: false` removes the fixed sentence naming DeepSeek Harness, so the persona prefix opens the prompt. The `console-mcp` row offers each configured server's tools as `mcp__<server id>__<tool>` and nothing while its list is empty. The `library-skills` row adds the bundled skills to the skill catalog, disabling the four shipped presets removes every other tool set a session could run under, and every other composed plugin owns its own model-visible contribution.

#### KV Cache effect

None beyond the composed plugins' own; the skill catalog is prefix-stable while the shipped skill set is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The lock is a launch argument.** A deployment that starts the profile without `--patch permission-lock.patch.yml` and without the home patch gets the shipped preset names, `/permission` in the slash menu, a `defaultPreset` any settings write can change, a Session-log upload one settings write away from on, a model route and default model any settings write can repoint, and page preferences and Host tunables one visitor's settings write changes for every visitor; `auto-compact` then runs at the plugin's own defaults, which are the same 60%, and `ui-chat`'s Performance & usage falls back to its schema default, `detailed`, which shows the per-Turn token usage under each completed answer. Its Agent-preset default is the Web bundle's `standard`, which this bundle disables, so every new session fails with `agent-preset/not-found`.
- **The MCP server list is deployment Config, not a setting.** `console-mcp.servers` sits in the bundle layer like the sidebar's menu, but it is not a `.volatile()` field: the settings service projects no form for it and refuses a write with `Plugin entry "console-mcp" has no volatile fields`, so no browser the deployment admits can add a server. A deployment names its servers by patching the row's `config` in its own layer, and a changed list takes effect when the row reloads. A bridged MCP tool declares no approval gate, so it runs under every access preset, under the credential the row's `auth` names.
- **A compaction's summary is out of a customer's reach.** While a compaction runs, the conversation shows `ui-chat`'s 正在压缩… (Compacting context…). Once it lands, the turn's process rows hold `server-sidebar`'s 已压缩较早的对话 (Earlier conversation compacted), and a failed attempt shows 较早的对话压缩失败 (Couldn’t compact the earlier conversation) as a row of its own; neither shows a count or a token figure. Before a turn's first request, the running and failed rows sit above the message the customer just sent, which enters the conversation only after the compaction. No row opens the summary `compaction-basic` wrote, which its summarizer prompt asks for in English, so a customer cannot read what the model reads in place of the earlier conversation. Neither preset composes `command-compact`, so the slash menu offers no `/compact`, whose card would show the item and token counts and open that summary.
- **Stop during a compaction at the start of a turn discards the message just sent.** A compaction before a turn's first request runs after the harness takes the message that started the turn from the queue and before it adds the message to the conversation. Pressing Stop while it runs cancels the summary and ends the turn, and the message is dropped: it never enters the conversation and is not answered. This is the harness's own behavior; compacting at 60% reaches it more often than the backend's own trigger does.
- **No visitor picks a language, a theme, or any other preference.** The lock holds every preference Settings → General offered for the whole deployment, and the page shows only the keyboard shortcuts and the current version. A visitor sees their own browser's language and system appearance, and nothing a visitor chooses is saved for anyone else. A row a deployment composes in its own layer with volatile fields is writable by every visitor until the deployment restates it in the lock.
- **Every admitted visitor is the Host's operator.** The connection admits every `/api` request that carries the login cookie as the Host's one operator, with no per-method check, so each Remote method the composition serves answers every signed-in visitor. This bundle disables the Host administration rows listed above, so plugin management, dynamic Cordis packages, terminals, provider discovery, directory browsing, Open In, Office rendering, and goals answer no visitor, and the `hmr` row no longer applies an on-disk profile change live; the [Host administration Note](../../../.agents/notes/implemented/architecture/2026-10-04-console-drops-host-administration-surfaces.md) records the decision. These remain reachable:
  - `/api/file` serves any absolute path the Host's filesystem provider reads, up to `attachments.imageLimits.maxImageBytes` (20 MiB by default); inline images in a conversation load through it.
  - `workspaceFiles.read`, `readBytes`, and `stat` read paths outside the workspace; the right sidebar's document tab, which a file link, a tool row's path, or a skill reference opens, reads through them.
  - `credentials.set` and `credentials.unset` write the managed credential store and return no value; a reference the deployment supplies from the process environment answers `credential/rejected`.
  - `session.create` accepts any absolute `cwd`, and `workspace-write` confines the session's file writes to that directory and the platform temporary roots; a write to the profile patch or the home patch needs the one wider-than-workspace approval the admitted visitor gives, and with `hmr` disabled it applies only at the next Host restart.
  - `session.*`, `workspace.*`, `job.*`, and `subagents.*` act on every session the Host serves.
  - `fileReferences.list` lists the names under a session's directory, and `account.*` signs the Host in to a DeepSeek account, whose token goes only to the account's inference origin.
  - A settings write to a volatile field the lock does not hold is re-serialized into the profile patch and applied on the spot; a write that adds or changes a `{ __jsExpr: … }` node is refused (core patch `settings-expression-write-guard`). The fields that stay writable are the sidebar's menu, which the sidebar saves, `ui-settings-general.welcomeNoticeVersion`, which no composed row writes, and `ui-settings-account`'s onboarding fields, which no page on the Web reads.
- **The `console` preset keeps the file tools.** `tool-fs` lets the agent write the skills it distils into `<workspace>/.dsh/skills`, and it also lets it write any other file the `permission` preset's sandbox admits.
- **The remote-surface e2e probes only the loopback HTTP path.** `server-sidebar.e2e.ts`'s `remoteCall` POSTs to `/api/<ns>/<method>` on loopback with the login cookie, so it exercises connection admission and the Gateway, but without auth-gate's ownsHost transport and without opening the WebSocket stream path; stream methods such as `workspaceFiles.changes` and the terminal streams are not probed, and `directory-picker`, `open-in-app`, and the `llm-deepseek` lock row are proven only by `tests/profile.spec.ts`. Gateway dispatch turns only on whether the service exists, so a disabled row is closed on every path; the gap is in the proof, not the closure.
- **The lock's preset table keeps `danger-full-access`.** It restates that preset with `approval: never`. Nothing composed in the console calls `PermissionPresetService.set` — `/permission` is isolated on the `permission` row, and the only other callers (auto-review, webhook) are not composed — so no session reaches it today. It is kept rather than dropped because a stored session created under it would fail to resolve a table that no longer carries it, and whether any such session exists cannot be checked from this package; a future composed row that called `set()` could switch a session to it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`permission-lock.patch.yml` is published through the `packageFileExtras` table in `scripts/check-workspace-constraints.ts`.

To replace the vendored `@haoran/dsh-auto-compact`, build the plugin from a clean copy of a pushed commit of its repository, not from a working checkout whose `lib/` may be older than its sources, run `pnpm pack`, put the tarball under `vendor/`, update the `file:` specifier, `tests/profile.spec.ts`, the archive path in `OVERRIDES` of `scripts/gen-third-party-notices.ts`, and the ledger record `console-vendored-plugin-notice` in `.claude/core-patches.md`, which names that path, and run `pnpm install`. The e2e harness links the unpacked copy under `node_modules/@haoran/dsh-auto-compact` into its profile (`apps/web/tests/console-launch.ts`'s `CONSOLE_ROWS`).

The `console-auto-compact` Web snapshot (`snapshots/web/console-auto-compact`, driven by `apps/web/tests/server-sidebar.e2e.ts`) replays an authored conversation through this bundle, the lock as the home patch, and a deployment layer, on a replay route whose models report a 200,000-token window. It pins the composition's system prompt and tool schemas, a compaction before the third turn's first request after the second reply reports 62.5% of the window, and the Chat column once it lands; two keyless runs in the same describe check that 57.5% compacts nothing and that the `standard` twin compacts at 62.5%. An edit to the persona, the skill catalog, a composed tool, or a row that adds a prompt section changes the pin: rerun that describe with `DSH_SNAPSHOT=refresh` and review the sidecars.

</details>
