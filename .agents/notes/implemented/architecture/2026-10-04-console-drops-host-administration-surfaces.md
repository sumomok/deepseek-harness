# Agent Note: The console composition drops Host administration surfaces, because every admitted visitor is the operator

Status: implemented

English | [中文](2026-10-04-console-drops-host-administration-surfaces.zh.md)

## Problem

The customer console admits every visitor who passes the deployment's login and the Host and Origin fence as the Host's one operator. `dsh-client-connection` authenticates the browser session and checks no method (`packages/client/connection/src/rpc-host.ts`), and the API Gateway claims every Typert Remote service registered on the root realm and dispatches it to that Peer (`packages/api/gateway/src/index.ts`). A method no console page calls is therefore still a method every signed-in visitor can call. The composed Web bundles mount Host services that administer the Host itself. `pluginManager.installBundle` runs `pnpm add` with a caller-chosen spec, and `setBundleEnabled` switches on the Inspector bundle, whose CDP target evaluates code in the Host. `dynamicCordisRunner.runHostHalf` activates caller-supplied code in a `node:vm` realm in the Host process. `terminal.create` spawns a shell outside the Agent sandbox with no approval step. `llm.discoverModels` fetches a caller-supplied URL, and `llm-pi-ai`'s volatile `providers` field adds a route with its own endpoint and credential reference. `directoryPicker.list` and `createDirectory` browse and create directories from the filesystem root. The volatile fields of `llm-deepseek`, `baseURL` and `apiKeyEnv` among them, and of `agent-default-model` let one settings write repoint every session's model requests, with whichever stored credential a reference names, or every new session's default model. The container holding these services also holds the DeepSeek key and the customer's MCP credentials. The [0.2.1-alpha.1 base Note](2026-10-04-server-console-on-the-0-2-1-alpha-1-base.md) recorded the plugin-management path and left withholding it to a mechanism the desktop line is designing.

## Decision

**The console composition keeps only the Host services a console feature uses.** Console end users administer no plugins, models, credentials, presets, or Host; the deployment fixes those in its own layer. The bundle layer, `packages/experimental/console-profile/cordis.patch.yml`, disables these rows by id, each group with a comment naming what it exposes to an admitted visitor:

- Plugin management: `plugin-manager`, `plugin-inventory`, `ui-plugin-manager`, and the four configuration pages `ui-settings-shell`, `ui-settings-agent-loop`, `ui-settings-subagent`, and `ui-settings-web-search`, which register only into `ui-plugin-manager`'s page.
- Dynamic Cordis packages: `cordis-host-runner`, `cordis-inspect-providers`, which registers into the runner, and `cordis-client-runner`, which calls the runner from every page.
- Interactive terminals: `terminal-controller` and `ui-sidebar-terminal`.
- Provider discovery: `llm-pi-ai`, the only discovery registrant, mounted with no provider.
- Web search and fetch: `web`, `web-search-deepseek`, and `web-fetch-http`, which serve no console preset's tool and hold a volatile endpoint and credential reference.
- Host paths outside the session tools: `directory-picker`, `open-in-app`, `ui-open-in-app`, and `office-to-pdf`.

**The lock pins the model route and the default model.** `permission-lock.patch.yml` adds `llm-deepseek` with `config: {}` and `agent-default-model` with `provider: deepseek-official` and `model: deepseek-flash`. config-editor refuses a settings write when the composed config differs from the value written, so a lock row locks only when it carries a `config` key; `{}` states the base bundle's configuration, which composes the row with none. With the lock composed, `session.selectModel` switches the one session and logs that the default was not saved. A deployment that configures either row in its own layer moves that config into the lock row, which replaces the whole config.

**`hmr` stays.** It has no Remote method; it applies a change to the profile's files on disk without a restart.

## What stays reachable

These Remote methods and routes still answer every admitted visitor, because a console feature needs their row or because only a change to an upstream-owned package closes them:

- `/api/file` serves any absolute path the Host's filesystem provider reads, up to `attachments.imageLimits.maxImageBytes`; inline images in a conversation load through it, and `session-controller` mounts it.
- `workspaceFiles.read`, `readBytes`, and `stat` read paths outside the workspace. The right sidebar's document tab reads through them, and a file link, a tool row's path, or a skill reference opens that tab.
- `credentials.set` and `credentials.unset` write the managed credential store and return no value. `settings-controller`, which backs every Settings row the console shows, mounts them; a reference the deployment supplies from the process environment answers `credential/rejected`.
- `session.create` accepts any absolute `cwd`, and `fs-sandbox` leaves reads unconfined and confines `workspace-write` writes to that directory and the platform temporary roots.
- `session.*`, `workspace.*`, `job.*`, and `subagents.*` act on every session; the console is single-tenant, so every visitor is the same operator.
- `goals.*` with `goal-round-driver` continues a session with model turns, which spends model tokens but reaches no code, credential, or file.
- `fileReferences.list` lists names under a session's directory for the composer's `@` mentions; `account.*` signs the Host in to a DeepSeek account, whose token `deepseek-account-platform` sends only to the account's inference origin.
- The volatile fields of `agent-loop`, `subagent`, `subagent-model-selection-settings`, `llm-deepseek-account`, `auto-compact`, and `ui-chat.busyCompaction` accept settings writes; no console preset delegates or runs the account route.

## Testing

`packages/experimental/console-profile/tests/profile.spec.ts` pins each group as a bare disable row in the console layer that the shipped bundles compose and enable, and pins the two lock rows against the base bundle's configuration. The server-sidebar scenario in `apps/web/tests/server-sidebar.e2e.ts` boots the console with the lock as the home patch and sends `client-request` envelopes with the login cookie, as the page's own client does. It requires 404 from `pluginManager.listBundles`, `setBundleEnabled`, `installBundle`, `pluginInventory.list`, `pluginRegistryProbe.fastest`, `dynamicCordisRunner.runHostHalf`, `terminal.create`, and `officeToPdf.render`; `llm.discoverModels` to report that no discovery is registered; a `settings.update` of `agent-default-model` to be refused; every composed Loader entry to be active; and `session.list` and `settings.describe` to answer. With the `plugin-manager` row removed, the case fails on `pluginManager.listBundles`. The scaffold disables `directory-picker` and `open-in-app` and inserts the browse picker itself, so that scenario does not cover those two rows.

## Alternatives considered

**Waiting for the desktop line's withholding mechanism**, which the base Note chose. The desktop Host serves one local person; the console Host serves every visitor of a deployment as that person, so plugin management there is code execution in the container that holds the deployment's credentials. No console page uses the disabled services, so a later mechanism that gates them per caller is adopted by re-enabling rows, and there is no console-only answer to reconcile with it.

**A per-method allow-list in the connection or the Gateway.** It would close every Remote the console does not call at once, including the ones listed above, but it is a change to `dsh-client-connection` and `dsh-api-gateway`, upstream-owned packages, and every row disabled here closes without one.

**Disabling `workspace-files` and the document tab as well.** `/api/file` reads the same paths, up to 20 MiB by default, and inline images need it, so closing `workspaceFiles.read` removes no read. `ui-sidebar-right`'s `openResource` throws for an address no tab type claims, so every file link, tool-row path, and skill reference a visitor opens would fail.

**Disabling only the pages.** Removing `ui-plugin-manager` or the right sidebar's Terminal tab removes controls nothing in the console reaches, while `pluginManager.*` and `terminal.*` keep answering every visitor.

**Leaving the four configuration pages composed.** They register only into `ui-plugin-manager`'s `plugins.item` slot, which nothing declares once that row is disabled; the Settings → Plugins inventory row is disabled for the same reason.

## Consequences

No admitted visitor can install or switch a plugin, run a dynamic Cordis package, open a terminal, run model discovery or add a provider route, browse or create directories outside a session's tools, launch a Host application, render an Office file, or repoint the model route or the default model. The console page loses the right sidebar's Terminal tab and Office previews, which report an error in the document tab; `session.selectModel` saves no choice as the default. A deployment that wants one of these surfaces back re-enables its rows in its own layer and accepts that every visitor reaches it, and a deployment that configures `llm-deepseek` or `agent-default-model` in its own layer moves that configuration into the lock. The reachable list above is what a per-caller gate in the connection, or a multi-tenant console, would have to close.
